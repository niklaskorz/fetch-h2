import {
	ClientHttp2Session,
	ClientHttp2Stream,
	connect as http2Connect,
	constants as h2constants,
	IncomingHttpHeaders as IncomingHttp2Headers,
	SecureClientSessionOptions,
} from "http2";
import { URL } from "url";

import { asyncGuard, syncGuard } from "callguard";

import {
	AbortError,
	Decoder,
	TimeoutError,
} from "./core";

import { Request } from "./request";
import { Response, StreamResponse } from "./response";
import { makeOkError } from "./utils";
import { setGotGoaway } from "./utils-http2";


const {
	HTTP2_HEADER_PATH,
} = h2constants;

interface H2SessionItem
{
	session: ClientHttp2Session;
	promise: Promise< ClientHttp2Session >;

	ref: ( ) => void;
	unref: ( ) => void;
}

export type PushHandler =
	(
		origin: string,
		request: Request,
		getResponse: ( ) => Promise< Response >
	) => void;

export type GetDecoders = ( origin: string ) => ReadonlyArray< Decoder >;
export type GetSessionOptions =
	( origin: string ) => SecureClientSessionOptions;

export class H2Context
{
	public _pushHandler?: PushHandler;

	private _h2sessions: Map< string, H2SessionItem > = new Map( );
	private _h2staleSessions: Map< string, Set< ClientHttp2Session > > =
		new Map( );
	private _getDecoders: GetDecoders;
	private _getSessionOptions: GetSessionOptions;

	constructor(
		getDecoders: GetDecoders,
		getSessionOptions: GetSessionOptions
	)
	{
		this._getDecoders = getDecoders;
		this._getSessionOptions = getSessionOptions;
	}

	public hasOrigin( origin: string )
	{
		return this._h2sessions.has( origin );
	}

	public getOrCreateHttp2(
		origin: string,
		extraOptions?: SecureClientSessionOptions
	)
	: {
		didCreate: boolean;
		session: Promise< ClientHttp2Session >;
		cleanup: ( ) => void;
	}
	{
		const willCreate = !this._h2sessions.has( origin );

		if ( willCreate )
		{
			const sessionItem = this.connectHttp2( origin, extraOptions );

			const { promise } = sessionItem;

			// Handle session closure (delete from store)
			promise
			.then( session =>
			{
				session.once(
					"close",
					( ) => this.disconnect( origin, session )
				);

				session.once(
					"goaway",
					(
						_errorCode: number,
						_lastStreamID: number,
						_opaqueData: Buffer
					) =>
					{
						setGotGoaway( session );
						this.releaseSession( origin );
					}
				);
			} )
			.catch( ( ) =>
			{
				if ( sessionItem.session )
					this.disconnect( origin, sessionItem.session );
			} );

			this._h2sessions.set( origin, sessionItem );
		}

		const { promise: session, ref, unref } =
			( < H2SessionItem >this._h2sessions.get( origin ) );

		if ( !willCreate )
			// This was re-used
			ref( );

		// Avoid potential double-clean races
		let hasCleanedUp = false;
		const cleanup = ( ) =>
		{
			if ( hasCleanedUp )
				return;
			hasCleanedUp = true;
			unref( );
		};

		return {
			cleanup,
			didCreate: willCreate,
			session,
		};
	}

	public disconnectSession( session: ClientHttp2Session ): Promise< void >
	{
		return new Promise< void >( resolve =>
		{
			if ( session.destroyed )
				return resolve( );

			session.once( "close", ( ) => resolve( ) );
			session.destroy( );
		} );
	}

	public releaseSession( origin: string ): void
	{
		const sessionItem = this.deleteActiveSession( origin );

		if ( !sessionItem )
			return;

		if ( !this._h2staleSessions.has( origin ) )
			this._h2staleSessions.set( origin, new Set( ) );

		( < Set< ClientHttp2Session > >this._h2staleSessions.get( origin ) )
			.add( sessionItem.session );
	}

	public deleteActiveSession( origin: string ): H2SessionItem | void
	{
		if ( !this._h2sessions.has( origin ) )
			return;

		const sessionItem = this._h2sessions.get( origin );
		this._h2sessions.delete( origin );

		return sessionItem;
	}

	public async disconnectStaleSessions( origin: string ): Promise< void >
	{
		const promises: Array< Promise< void > > = [ ];

		if ( !this._h2staleSessions.has( origin ) )
			return;

		const sessionSet =
			< Set< ClientHttp2Session > >this._h2staleSessions.get( origin );
		this._h2staleSessions.delete( origin );

		for ( const session of sessionSet )
			promises.push( this.disconnectSession( session ) );

		return Promise.all( promises ).then( ( ) => { } );
	}

	public disconnectAll( ): Promise< void >
	{
		const promises: Array< Promise< void > > = [ ];

		for ( const eventualH2session of this._h2sessions.values( ) )
		{
			promises.push( this.handleDisconnect( eventualH2session ) );
		}
		this._h2sessions.clear( );

		for ( const origin of this._h2staleSessions.keys( ) )
		{
			promises.push( this.disconnectStaleSessions( origin ) );
		}

		return Promise.all( promises ).then( ( ) => { } );
	}

	public disconnect( url: string, session?: ClientHttp2Session ): Promise< void >
	{
		const { origin } = new URL( url );
		const promises: Array< Promise< void > > = [ ];

		const sessionItem = this.deleteActiveSession( origin );

		if ( sessionItem && ( !session || sessionItem.session === session ) )
			promises.push( this.handleDisconnect( sessionItem ) );

		if ( !session )
		{
			promises.push( this.disconnectStaleSessions( origin ) );
		}
		else if ( this._h2staleSessions.has( origin ) )
		{
			const sessionSet =
				< Set< ClientHttp2Session > >
					this._h2staleSessions.get( origin );
			if ( sessionSet.has( session ) )
			{
				sessionSet.delete( session );
				promises.push( this.disconnectSession( session ) );
			}
		}

		return Promise.all( promises ).then( ( ) => { } );
	}

	private handleDisconnect( sessionItem: H2SessionItem ): Promise< void >
	{
		const { promise, session } = sessionItem;

		if ( session )
			session.destroy( );

		return promise
		.then( _h2session => { } )
		.catch( err =>
		{
			const debugMode = false;
			if ( debugMode )
				// tslint:disable-next-line
				console.warn( "Disconnect error", err );
		} );
	}

	private handlePush(
		origin: string,
		pushedStream: ClientHttp2Stream,
		requestHeaders: IncomingHttp2Headers,
		ref: ( ) => void,
		unref: ( ) => void
	)
	{
		if ( !this._pushHandler )
			return; // Drop push. TODO: Signal through error log: #8

		const path = requestHeaders[ HTTP2_HEADER_PATH ] as string;

		// Remove pseudo-headers
		Object.keys( requestHeaders )
		.filter( name => name.charAt( 0 ) === ":" )
		.forEach( name => { delete requestHeaders[ name ]; } );

		const pushedRequest = new Request( path, { headers: requestHeaders } );

		ref( );

		const futureResponse = new Promise< Response >( ( resolve, reject ) =>
		{
			const guard = syncGuard( reject, { catchAsync: true } );

			pushedStream.once( "close", unref );

			pushedStream.once( "aborted", ( ) =>
				reject( new AbortError( "Response aborted" ) )
			);
			pushedStream.once( "frameError", ( ) =>
				reject( new Error( "Push request failed" ) )
			);
			pushedStream.once( "error", reject );

			pushedStream.once( "push", guard(
				( responseHeaders: IncomingHttp2Headers ) =>
				{
					const response = new StreamResponse(
						this._getDecoders( origin ),
						path,
						pushedStream,
						responseHeaders,
						false,
						{ },
						2
					);

					resolve( response );
				}
			) );
		} );

		futureResponse
		.catch( _err => { } ); // TODO: #8

		const getResponse = ( ) => futureResponse;

		return this._pushHandler( origin, pushedRequest, getResponse );
	}

	private connectHttp2(
		origin: string,
		extraOptions: SecureClientSessionOptions = { }
	)
	: H2SessionItem
	{
		const makeConnectionTimeout = ( ) =>
			new TimeoutError( `Connection timeout to ${origin}` );

		const makeError = ( event?: string ) =>
			event
			? new Error( `Unknown connection error (${event}): ${origin}` )
			: new Error( `Connection closed` );

		let session: ClientHttp2Session = < ClientHttp2Session >< any >void 0;

		// TODO: #8
		// tslint:disable-next-line
		const aGuard = asyncGuard( console.error.bind( console ) );

		const sessionRefs: Partial< H2SessionItem > = { };

		const makeRefs = ( session: ClientHttp2Session ) =>
		{
			let counter = 1; // Begins ref'd
			sessionRefs.ref = ( ) =>
			{
				if ( session.destroyed )
					return;

				if ( counter === 0 )
					// Go from unref'd to ref'd
					session.ref( );
				++counter;
			};
			sessionRefs.unref = ( ) =>
			{
				if ( session.destroyed )
					return;

				--counter;
				if ( counter === 0 )
					// Go from ref'd to unref'd
					session.unref( );
			};
		};

		const options = {
			...this._getSessionOptions( origin ),
			...extraOptions,
		};

		const promise = new Promise< ClientHttp2Session >(
			( resolve, reject ) =>
			{
				session =
					http2Connect( origin, options, ( ) => resolve( session ) );

				makeRefs( session );

				session.on( "stream", aGuard(
					(
						stream: ClientHttp2Stream,
						headers: IncomingHttp2Headers
					) =>
						this.handlePush(
							origin,
							stream,
							headers,
							< ( ) => void >sessionRefs.ref,
							< ( ) => void >sessionRefs.unref
						)
				) );

				session.once( "close", ( ) =>
					reject( makeOkError( makeError( ) ) ) );

				session.once( "timeout", ( ) =>
					reject( makeConnectionTimeout( ) ) );

				session.once( "error", reject );
			}
		);

		return {
			promise,
			ref: < ( ) => void >sessionRefs.ref,
			session,
			unref: < ( ) => void >sessionRefs.unref,
		};
	}
}
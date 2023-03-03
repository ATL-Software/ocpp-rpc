import {EventEmitter, once} from 'events';
import {WebSocketServer, WebSocket} from 'ws';
import {createServer, IncomingMessage} from 'node:http';
import { RPCServerClient } from './server-client';
import { abortHandshake, parseSubprotocols } from './ws-util';
import standardValidators from './standard-validators';
import { getPackageIdent } from './util';
import { WebsocketUpgradeError } from './errors';
import { Validator } from './validator';
import { Socket } from 'net';
import { TLSSocket } from 'tls';
import { StateEnum } from './baseclient';
import { URLSearchParams } from 'url';


export interface RPCServerClientHandshake {
    protocols: Set<string>;
    identity: string;
    password?: Buffer;
    endpoint: string;
    query: URLSearchParams;
    remoteAddress: string;
    headers: object;
    request: IncomingMessage;
}

export interface RPCServerOptionsReconfigurable {
    protocols?: string[];
    callTimeoutMs?: number;
    pingIntervalMs?: number;
    deferPingsOnActivity?: boolean;
    respondWithDetailedErrors?: boolean;
    callConcurrency?: number;
    maxBadMessages?: number;
    strictMode?: boolean | string[];
    strictModeValidators?: Validator[];
}

export interface ListenOptions {
    signal?: AbortSignal;
}

export interface RPCServerOptions extends RPCServerOptionsReconfigurable {
    wssOptions?: object;
}

export type AuthCallback = (
    accept: (session?: any, protocol?: string) => void,
    reject: (code?: number, message?: string) => void,
    handshake: RPCServerClientHandshake,
    signal: AbortSignal
) => {};

export interface ServerCloseOptions {
    code?: number;
    reason?: string;
    awaitPending?: boolean;
    force?: boolean;
};

export class RPCServer extends EventEmitter {
    private _httpServerAbortControllers: Set<AbortController>;
    private _state: StateEnum;
    private _clients: Set<RPCServerClient>;
    private _pendingUpgrades: WeakMap<IncomingMessage, {handshake: RPCServerClientHandshake, session?: any, protocol?: string}>;
    private _options: RPCServerOptions;
    private _wss: WebSocketServer;
    private _strictValidators!: Map<string, Validator>;
    private _authCallback?: AuthCallback;

    constructor(options: RPCServerOptions) {
        super();
        
        this._httpServerAbortControllers = new Set();
        this._state = StateEnum.OPEN;
        this._clients = new Set();
        this._pendingUpgrades = new WeakMap();

        this._options = {
            // defaults
            wssOptions: {},
            protocols: [],
            callTimeoutMs: 1000*30,
            pingIntervalMs: 1000*30,
            deferPingsOnActivity: false,
            respondWithDetailedErrors: false,
            callConcurrency: 1,
            maxBadMessages: Infinity,
            strictMode: false,
            strictModeValidators: [],
        };

        this.reconfigure(options || {});

        this._wss = new WebSocketServer({
            ...this._options.wssOptions,
            noServer: true,
            handleProtocols: (protocols, request) => {
                const pendingUpgrade = this._pendingUpgrades.get(request);
                return pendingUpgrade?.protocol ?? false;
            },
        });

        this._wss.on('headers', (headers: string[]) => headers.push(`Server: ${getPackageIdent()}`));
        this._wss.on('error', (err: Error) => this.emit('error', err));
        this._wss.on('connection', this._onConnection.bind(this));
    }
    
    reconfigure(options: RPCServerOptionsReconfigurable) {
        const newOpts = Object.assign({}, this._options, options);

        if (newOpts.strictMode && !newOpts.protocols?.length) {
            throw Error(`strictMode requires at least one subprotocol`);
        }

        const strictValidators = [...standardValidators];
        if (newOpts.strictModeValidators) {
            strictValidators.push(...newOpts.strictModeValidators);
        }

        this._strictValidators = strictValidators.reduce((svs, v) => {
            svs.set(v.subprotocol, v);
            return svs;
        }, new Map());
        
        let strictProtocols: string[] = [];
        if (Array.isArray(newOpts.strictMode)) {
            strictProtocols = newOpts.strictMode;
        } else if (newOpts.strictMode) {
            if (!newOpts.protocols) {
                throw Error(`To use strictMode, you must specify at least one subprotocol in options.protocols or pass a list of protocols to options.strictMode`);
            }
            strictProtocols = newOpts.protocols;
        }

        const missingValidator = strictProtocols.find(protocol => !this._strictValidators.has(protocol));
        if (missingValidator) {
            throw Error(`Missing strictMode validator for subprotocol '${missingValidator}'`);
        }

        this._options = newOpts;
    }

    get handleUpgrade() {
        return async (request: IncomingMessage, socket: Socket | TLSSocket, head: Buffer) => {

            let resolved = false;

            const ac = new AbortController();
            const {signal} = ac;

            const url = new URL(request.url ?? '/', 'http://localhost');
            const pathParts = url.pathname.split('/');
            const identity = decodeURIComponent(pathParts.pop()!);

            const abortUpgrade = (error: Error) => {
                resolved = true;

                if (error && error instanceof WebsocketUpgradeError) {
                    abortHandshake(socket, error.code, error.message);
                } else {
                    abortHandshake(socket, 500);
                }

                if (!signal.aborted) {
                    ac.abort(error);
                    this.emit('upgradeAborted', {
                        error,
                        socket,
                        request,
                        identity,
                    });
                }
            };

            socket.on('error', (err) => {
                abortUpgrade(err);
            });

            try {
                if (this._state !== StateEnum.OPEN) {
                    throw new WebsocketUpgradeError(500, "Server not open");
                }
                
                if (socket.readyState !== 'open') {
                    throw new WebsocketUpgradeError(400, `Client readyState = '${socket.readyState}'`);
                }
                
                const headers = request.headers;

                if (headers.upgrade?.toLowerCase() !== 'websocket') {
                    throw new WebsocketUpgradeError(400, "Can only upgrade websocket upgrade requests");
                }
                
                const endpoint = pathParts.join('/');
                const remoteAddress = request.socket.remoteAddress ?? '';
                const protocols = request.headers.hasOwnProperty('sec-websocket-protocol')
                    ? parseSubprotocols(request.headers['sec-websocket-protocol'] ?? '')
                    : new Set<string>();

                let password;
                if (headers.authorization) {
                    try {
                        /**
                         * This is a non-standard basic auth parser because it supports
                         * colons in usernames (which is normally disallowed).
                         * However, this shouldn't cause any confusion as we have a
                         * guarantee from OCPP that the username will always be equal to
                         * the identity.
                         * It also supports binary passwords, which is also a spec violation
                         * but is necessary for allowing truly random binary keys as
                         * recommended by the OCPP security whitepaper.
                         */
                        const b64up = headers.authorization.match(/^ *(?:[Bb][Aa][Ss][Ii][Cc]) +([A-Za-z0-9._~+/-]+=*) *$/)?.[1];
                        if (!b64up) throw Error("Auth b64 not found");
                        const userPassBuffer = Buffer.from(b64up, 'base64');

                        const clientIdentityUserBuffer = Buffer.from(identity + ':');

                        if (clientIdentityUserBuffer.compare(userPassBuffer, 0, clientIdentityUserBuffer.length) === 0) {
                            // first part of buffer matches `${identity}:`
                            password = userPassBuffer.subarray(clientIdentityUserBuffer.length);
                        }
                    } catch (err) {
                        // failing to parse authorization header is no big deal.
                        // just leave password as undefined as if no header was sent.
                    }
                }

                const handshake: RPCServerClientHandshake = {
                    remoteAddress,
                    headers,
                    protocols,
                    endpoint,
                    identity,
                    query: url.searchParams,
                    request,
                    password,
                };

                const accept = (session?: any, protocol?: string) => {
                    if (resolved) return;
                    resolved = true;
                    
                    try {
                        if (socket.readyState !== 'open') {
                            throw new WebsocketUpgradeError(400, `Client readyState = '${socket.readyState}'`);
                        }

                        if (protocol == null) {
                            // pick first subprotocol (preferred by server) that is also supported by the client
                            protocol = (this._options.protocols ?? []).find(p => protocols.has(p));
                        } else if (protocol != null && !protocols.has(protocol)) {
                            throw new WebsocketUpgradeError(400, `Client doesn't support expected subprotocol`);
                        }

                        // cache auth results for connection creation
                        this._pendingUpgrades.set(request, {
                            session: session ?? {},
                            protocol,
                            handshake
                        });

                        this._wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
                            this._wss.emit('connection', ws, request);
                        });
                    } catch (err: any) {
                        abortUpgrade(err);
                    }
                };

                const reject = (code = 404, message = 'Not found') => {
                    if (resolved) return;
                    resolved = true;
                    abortUpgrade(new WebsocketUpgradeError(code, message));
                };

                socket.once('end', () => {
                    reject(400, `Client connection closed before upgrade complete`);
                });

                socket.once('close', () => {
                    reject(400, `Client connection closed before upgrade complete`);
                });

                if (this._authCallback) {
                    await this._authCallback(
                        accept,
                        reject,
                        handshake,
                        signal
                    );
                } else {
                    accept();
                }

            } catch (err: any) {
                abortUpgrade(err);
            }
        };
    }

    async _onConnection(websocket: WebSocket, request: IncomingMessage) {
        try {
            if (this._state !== StateEnum.OPEN) {
                throw Error("Server is no longer open");
            }

            const pendingUpgrade = this._pendingUpgrades.get(request);
            if (!pendingUpgrade) {
                throw Error("Upgrade is not pending");
            }

            const {handshake, session} = pendingUpgrade;

            const client = new RPCServerClient({
                identity: handshake.identity,
                callTimeoutMs: this._options.callTimeoutMs,
                pingIntervalMs: this._options.pingIntervalMs,
                deferPingsOnActivity: this._options.deferPingsOnActivity,
                respondWithDetailedErrors: this._options.respondWithDetailedErrors,
                callConcurrency: this._options.callConcurrency,
                strictMode: this._options.strictMode,
                strictModeValidators: this._options.strictModeValidators,
                maxBadMessages: this._options.maxBadMessages,
                protocols: this._options.protocols,
                headers: request.headers,
                reconnect: false,
                endpoint: request.url!,
            }, {
                ws: websocket,
                session,
                handshake,
            });

            this._clients.add(client);
            client.once('close', () => this._clients.delete(client));
            this.emit('client', client);

        } catch (err: any) {
            websocket.close(err.statusCode ?? 1000, err.message);
        }
    }

    auth(cb?: AuthCallback) {
        this._authCallback = cb;
    }

    async listen(port: number, host?: string, options: ListenOptions = {}) {
        const ac = new AbortController();
        this._httpServerAbortControllers.add(ac);
        const signal = options.signal;
        if (signal) {
            once(signal, 'abort').then(() => {
                ac.abort(signal.reason);
            });
        }
        const httpServer = createServer({
            noDelay: true,
        }, (req, res) => {
            res.setHeader('Server', getPackageIdent());
            res.statusCode = 404;
            res.end();
        });
        httpServer.on('upgrade', this.handleUpgrade);
        httpServer.once('close', () => this._httpServerAbortControllers.delete(ac));

        httpServer.listen({
            port,
            host,
            signal: ac.signal,
        });

        const complete = await Promise.race([
            once(httpServer, 'listening', {signal: ac.signal}),
            once(httpServer, 'error', {signal: ac.signal}),
            once(ac.signal, 'abort')
        ]);

        if (complete instanceof Error) {
            throw complete;
        }

        return httpServer;
    }

    async close({code, reason, awaitPending, force}: ServerCloseOptions = {}) {
        if (this._state === StateEnum.OPEN) {
            this._state = StateEnum.CLOSING;
            this.emit('closing');
            code = code ?? 1001;
            await Array.from(this._clients).map(cli => cli.close({code, reason, awaitPending, force}));
            await new Promise<void>((resolve, reject) => {
                this._wss.close((err?: Error) => err ? reject(err) : resolve());
                this._httpServerAbortControllers.forEach(ac => ac.abort("Closing"));
            });
            this._state = StateEnum.CLOSED;
            this.emit('close');
        }
    }
}

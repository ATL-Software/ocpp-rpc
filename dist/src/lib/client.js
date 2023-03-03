"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RPCClient = exports.StateEnum = void 0;
const promises_1 = require("node:timers/promises");
const ws_1 = require("ws");
const backoff_1 = require("backoff");
const errors_1 = require("./errors");
const util_1 = require("./util");
const event_buffer_1 = require("./event-buffer");
const baseclient_1 = require("./baseclient");
var StateEnum;
(function (StateEnum) {
    StateEnum[StateEnum["CONNECTING"] = ws_1.WebSocket.CONNECTING] = "CONNECTING";
    StateEnum[StateEnum["OPEN"] = ws_1.WebSocket.OPEN] = "OPEN";
    StateEnum[StateEnum["CLOSING"] = ws_1.WebSocket.CLOSING] = "CLOSING";
    StateEnum[StateEnum["CLOSED"] = ws_1.WebSocket.CLOSED] = "CLOSED";
})(StateEnum = exports.StateEnum || (exports.StateEnum = {}));
class RPCClient extends baseclient_1.RPCBaseClient {
    _identity;
    _state;
    _ws;
    _protocol;
    _options;
    _backoffStrategy;
    _connectionUrl;
    constructor(options) {
        super(options);
        this._identity = options.identity;
        this._state = StateEnum.CLOSED;
        this._ws = undefined;
        this._protocol = undefined;
        this._options = {
            // defaults
            identity: '',
            endpoint: 'ws://localhost',
            password: undefined,
            callTimeoutMs: 1000 * 60,
            pingIntervalMs: 1000 * 30,
            deferPingsOnActivity: false,
            wsOpts: {},
            headers: {},
            protocols: [],
            reconnect: true,
            maxReconnects: Infinity,
            respondWithDetailedErrors: false,
            callConcurrency: 1,
            maxBadMessages: Infinity,
            strictMode: false,
            strictModeValidators: [],
            backoff: {
                initialDelay: 1000,
                maxDelay: 10 * 1000,
                factor: 2,
                randomisationFactor: 0.25,
            }
        };
        this.reconfigure(options || {});
    }
    reconfigure(options) {
        super.reconfigure(options);
        this._backoffStrategy = new backoff_1.ExponentialStrategy(this._options.backoff);
    }
    /**
     * Attempt to connect to the RPCServer.
     * @returns {Promise<undefined>} Resolves when connected, rejects on failure
     */
    async connect() {
        this._protocolOptions = this._options.protocols ?? [];
        this._protocol = undefined;
        this._identity = this._options.identity;
        let connUrl = this._options.endpoint + '/' + encodeURIComponent(this._options.identity);
        if (this._options.query) {
            const searchParams = new URLSearchParams(this._options.query);
            connUrl += '?' + searchParams.toString();
        }
        this._connectionUrl = new URL(connUrl);
        if (this._state === StateEnum.CLOSED) {
            try {
                return await this._beginConnect();
            }
            catch (err) {
                this._state = StateEnum.CLOSED;
                this.emit('close', { code: 1006, reason: "Abnormal Closure" });
                throw err;
            }
        }
        else if (this._state === StateEnum.CLOSING) {
            throw Error(`Cannot connect while closing`);
        }
        else if ([StateEnum.OPEN, StateEnum.CONNECTING].includes(this._state)) {
            // no-op
            return this._connectPromise;
        }
        throw Error(`Client in unexpected state`);
    }
    _handleDisconnect({ code, reason }) {
        if (reason instanceof Buffer) {
            reason = reason.toString('utf8');
        }
        // reject any outstanding calls/responses
        this._rejectPendingCalls("Client disconnected");
        this._keepAliveAbortController?.abort();
        this.emit('disconnect', { code, reason });
        if (this._state === StateEnum.CLOSED) {
            // nothing to do here
            return;
        }
        if (this._state !== StateEnum.CLOSING && this._options.reconnect) {
            this._tryReconnect();
        }
        else {
            this._state = StateEnum.CLOSED;
            this.emit('close', { code, reason });
        }
    }
    _beginConnect() {
        this._connectPromise = (async () => {
            this._wsAbortController = new AbortController();
            const wsOpts = Object.assign({
                // defaults
                noDelay: true,
                signal: this._wsAbortController.signal,
                headers: {
                    'user-agent': (0, util_1.getPackageIdent)()
                },
            }, this._options.wsOpts ?? {});
            Object.assign(wsOpts.headers, this._options.headers);
            if (this._options.password != null) {
                const usernameBuffer = Buffer.from(this._identity + ':');
                let passwordBuffer = this._options.password;
                if (typeof passwordBuffer === 'string') {
                    passwordBuffer = Buffer.from(passwordBuffer, 'utf8');
                }
                const b64 = Buffer.concat([usernameBuffer, passwordBuffer]).toString('base64');
                wsOpts.headers.authorization = 'Basic ' + b64;
            }
            this._ws = new ws_1.WebSocket(this._connectionUrl, this._protocolOptions, wsOpts);
            const leadMsgBuffer = new event_buffer_1.default(this._ws, 'message');
            let upgradeResponse;
            try {
                await new Promise((resolve, reject) => {
                    if (!this._ws) {
                        return reject(Error("WebSocket missing"));
                    }
                    this._ws.once('unexpected-response', (request, response) => {
                        const err = new errors_1.UnexpectedHttpResponse(response.statusMessage);
                        err.code = response.statusCode;
                        err.request = request;
                        err.response = response;
                        reject(err);
                    });
                    this._ws.once('upgrade', (response) => {
                        upgradeResponse = response;
                    });
                    this._ws.once('error', err => reject(err));
                    this._ws.once('open', () => resolve(null));
                });
                // record which protocol was selected
                if (this._protocol === undefined) {
                    this._protocol = this._ws.protocol;
                    this.emit('protocol', this._protocol);
                }
                // limit protocol options in case of future reconnect
                this._protocolOptions = this._protocol ? [this._protocol] : [];
                this._reconnectAttempt = 0;
                this._backoffStrategy.reset();
                this._state = StateEnum.OPEN;
                this._connectedOnce = true;
                this._pendingPingResponse = false;
                this._attachWebsocket(this._ws, leadMsgBuffer);
                // send queued messages
                if (this._outboundMsgBuffer.length > 0) {
                    const buff = this._outboundMsgBuffer;
                    this._outboundMsgBuffer = [];
                    buff.forEach(msg => this.sendRaw(msg));
                }
                const result = {
                    response: upgradeResponse,
                };
                this.emit('open', result);
                return result;
            }
            catch (err) {
                this._ws.terminate();
                throw err;
            }
        })();
        this._state = StateEnum.CONNECTING;
        this.emit('connecting', { protocols: this._protocolOptions });
        return this._connectPromise;
    }
    async _tryReconnect() {
        this._reconnectAttempt++;
        if (this._reconnectAttempt > this._options.maxReconnects) {
            // give up
            this.close({ code: 1001, reason: "Giving up" });
        }
        else {
            try {
                this._state = StateEnum.CONNECTING;
                const delay = this._backoffStrategy.next();
                await (0, promises_1.setTimeout)(delay, null, { signal: this._wsAbortController?.signal });
                await this._beginConnect().catch(async (err) => {
                    const intolerableErrors = [
                        'Maximum redirects exceeded',
                        'Server sent no subprotocol',
                        'Server sent an invalid subprotocol',
                        'Server sent a subprotocol but none was requested',
                        'Invalid Sec-WebSocket-Accept header',
                    ];
                    if (intolerableErrors.includes(err.message)) {
                        throw err;
                    }
                    this._tryReconnect();
                }).catch(err => {
                    this.close({ code: 1001, reason: err.message });
                });
            }
            catch (err) {
                // aborted timeout
                return;
            }
        }
    }
}
exports.RPCClient = RPCClient;

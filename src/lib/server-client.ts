import { WebSocket } from "ws";
import { RPCBaseClient, RPCBaseClientOptions } from "./baseclient";
import { StateEnum } from "./client";
import { RPCServerClientHandshake } from "./server";
import { ProtocolNames } from "./protocols";

export interface RPCServerClientDependencies {
    query?: string | string[][] | URLSearchParams;
    ws: WebSocket;
    handshake: RPCServerClientHandshake;
    session: any;
}

export class RPCServerClient<T extends ProtocolNames> extends RPCBaseClient<T> {
    private _session: any;
    private _handshake: RPCServerClientHandshake;

    constructor(options: RPCBaseClientOptions, {ws, handshake, session}: RPCServerClientDependencies) {
        super(options);

        this._session = session;
        this._handshake = handshake;
        
        this._state = StateEnum.OPEN;
        this._identity = this._options.identity;
        this._ws = ws;
        this._protocol = ws.protocol as T;
        this._attachWebsocket(this._ws);
    }

    get handshake() {
        return this._handshake;
    }

    get session() {
        return this._session;
    }
}

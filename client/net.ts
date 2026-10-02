// Transporte de red del motor: reemplaza los sockets UDP por un DataChannel WebRTC
// no confiable (unordered, sin retransmisiones), que se comporta igual que UDP.
import { Net, Xash3D, type Packet, type Xash3DOptions } from 'xash3d-fwgs';
import { SERVER_IP, SERVER_PORT, queueCommands } from './engine';

type Signal =
    | { type: 'offer'; sdp: string }
    | { type: 'candidate'; candidate: string; mid: string }
    | { type: 'ready' };

export class Xash3DWebRTC extends Xash3D {
    private channel?: RTCDataChannel;
    private peer?: RTCPeerConnection;
    private ws?: WebSocket;
    private closedByUser = false;
    onTransportState?: (state: 'connecting' | 'connected' | 'lost') => void;

    constructor(opts?: Xash3DOptions) {
        super(opts);
        this.net = new Net(this, { maxPackets: 1024 });
    }

    // Llamado por el motor por cada paquete UDP saliente
    sendto(packet: Packet) {
        const ch = this.channel;
        if (!ch || ch.readyState !== 'open') return;
        const [a, b, c, d] = packet.ip;
        const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
        // sólo tráfico hacia "el servidor" (o broadcast LAN); se descarta el resto (master servers, etc.)
        if (a !== 127 && !broadcast) return;
        ch.send(packet.data as unknown as ArrayBufferView<ArrayBuffer>);
    }

    private receive(data: ArrayBuffer) {
        (this.net as Net).incoming.enqueue({
            data: new Uint8Array(data) as unknown as Int8Array,
            ip: SERVER_IP,
            port: SERVER_PORT,
        });
    }

    // Abre la señalización y el DataChannel. Resuelve cuando el puente del servidor está listo.
    connectTransport(timeoutMs = 15000): Promise<void> {
        this.onTransportState?.('connecting');
        return new Promise((resolve, reject) => {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(`${proto}://${location.host}/signal`);
            const peer = new RTCPeerConnection({ iceServers: [] });
            this.ws = ws;
            this.peer = peer;
            let remoteSet = false;
            let channelOpen = false;
            let bridgeReady = false;
            let settled = false;
            const pending: RTCIceCandidateInit[] = [];

            const timer = setTimeout(() => fail(new Error('No se pudo establecer la conexión WebRTC con el servidor (¿firewall bloqueando UDP?)')), timeoutMs);
            const done = () => {
                if (settled || !channelOpen || !bridgeReady) return;
                settled = true;
                clearTimeout(timer);
                this.onTransportState?.('connected');
                resolve();
            };
            const fail = (err: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(); } catch { /* */ }
                try { peer.close(); } catch { /* */ }
                reject(err);
            };
            const send = (msg: object) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
            };

            peer.onicecandidate = (e) => {
                if (e.candidate && e.candidate.candidate) {
                    send({ type: 'candidate', candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' });
                }
            };
            peer.ondatachannel = (e) => {
                const ch = e.channel;
                ch.binaryType = 'arraybuffer';
                ch.onmessage = (ev) => this.receive(ev.data as ArrayBuffer);
                ch.onopen = () => {
                    this.channel = ch;
                    channelOpen = true;
                    done();
                };
                ch.onclose = () => this.lost(peer);
            };
            peer.onconnectionstatechange = () => {
                if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
                    if (!settled) fail(new Error(`WebRTC: ${peer.connectionState}`));
                    else this.lost(peer);
                }
            };

            ws.onmessage = async (ev) => {
                const msg = JSON.parse(ev.data) as Signal;
                try {
                    if (msg.type === 'offer') {
                        await peer.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
                        const answer = await peer.createAnswer();
                        await peer.setLocalDescription(answer);
                        send({ type: 'answer', sdp: answer.sdp });
                        remoteSet = true;
                        for (const c of pending.splice(0)) await peer.addIceCandidate(c).catch(() => undefined);
                    } else if (msg.type === 'candidate') {
                        const c = { candidate: msg.candidate.replace(/^a=/, ''), sdpMid: msg.mid };
                        if (remoteSet) await peer.addIceCandidate(c).catch(() => undefined);
                        else pending.push(c);
                    } else if (msg.type === 'ready') {
                        bridgeReady = true;
                        done();
                    }
                } catch (err) {
                    fail(err as Error);
                }
            };
            ws.onerror = () => fail(new Error('No se pudo conectar con el servidor de señalización'));
            ws.onclose = () => {
                if (!settled) fail(new Error('El servidor cerró la conexión'));
            };
        });
    }

    private lostHandled = new WeakSet<RTCPeerConnection>();

    // La conexión se cayó en medio del juego: reintentar y reconectar al servidor
    private lost(peer: RTCPeerConnection) {
        if (this.closedByUser || this.peer !== peer || this.lostHandled.has(peer)) return;
        this.lostHandled.add(peer);
        this.channel = undefined;
        this.onTransportState?.('lost');
        try { this.ws?.close(); } catch { /* */ }
        try { peer.close(); } catch { /* */ }
        const retry = (delay: number) => setTimeout(() => {
            this.connectTransport()
                .then(() => queueCommands(this, ['retry']))
                .catch(() => retry(Math.min(delay * 2, 10000)));
        }, delay);
        retry(1000);
    }

    disconnectTransport() {
        this.closedByUser = true;
        try { this.ws?.close(); } catch { /* */ }
        try { this.peer?.close(); } catch { /* */ }
    }
}

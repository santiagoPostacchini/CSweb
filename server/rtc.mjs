// Puente WebRTC <-> UDP.
// Cada navegador abre un DataChannel no confiable/desordenado (se comporta como UDP).
// Por cada jugador se crea un socket UDP local con su propia IP de loopback
// (127.0.X.Y), así el servidor dedicado ve a cada jugador como una IP distinta.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import nodeDataChannel from 'node-datachannel';

const MAX_BUFFERED = 1 << 20;

export class RtcBridge extends EventEmitter {
    constructor(cfg) {
        super();
        this.cfg = cfg;
        this.peers = new Set();
        this.slots = new Set();
        this.nextId = 1;
    }

    get count() {
        return [...this.peers].filter(p => p.open).length;
    }

    allocSlot() {
        for (let i = 0; i < 254 * 200; i++) {
            if (!this.slots.has(i)) {
                this.slots.add(i);
                return i;
            }
        }
        throw new Error('sin slots libres');
    }

    // ws: conexión WebSocket de señalización (paquete "ws")
    handle(ws, remote) {
        const cfg = this.cfg;
        const id = this.nextId++;
        const slot = this.allocSlot();
        const loopback = `127.0.${1 + Math.floor(slot / 254)}.${1 + (slot % 254)}`;
        const peer = { id, open: false, remote };
        this.peers.add(peer);

        const send = (obj) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(obj));
        };

        const pc = new nodeDataChannel.PeerConnection(`jugador-${id}`, {
            iceServers: [],
            enableIceUdpMux: true,
            portRangeBegin: cfg.webrtcPort,
            portRangeEnd: cfg.webrtcPort,
            maxMessageSize: 65536,
        });

        let udp = null;
        let dc = null;
        let heartbeat = null;
        let closed = false;
        const cleanup = (why) => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            const wasOpen = peer.open;
            peer.open = false;
            if (wasOpen) this.emit('leave', peer, why);
            this.peers.delete(peer);
            this.slots.delete(slot);
            try { udp?.close(); } catch { /* ya cerrado */ }
            try { dc?.close(); } catch { /* ya cerrado */ }
            try { pc.close(); } catch { /* ya cerrado */ }
            try { ws.close(); } catch { /* ya cerrado */ }
        };

        pc.onLocalDescription((sdp, type) => send({ type, sdp }));
        pc.onLocalCandidate((candidate, mid) => send({ type: 'candidate', candidate, mid }));
        pc.onStateChange((state) => {
            if (state === 'failed' || state === 'closed') cleanup(`webrtc ${state}`);
        });

        dc = pc.createDataChannel('game', { unordered: true, maxRetransmits: 0 });

        dc.onOpen(() => {
            udp = dgram.createSocket('udp4');
            udp.on('error', (err) => cleanup(`udp: ${err.message}`));
            udp.on('message', (msg, rinfo) => {
                if (rinfo.port !== cfg.gamePort) return;
                if (!dc.isOpen() || dc.bufferedAmount() > MAX_BUFFERED) return;
                dc.sendMessageBinary(msg);
            });
            udp.bind(0, loopback, () => {
                peer.open = true;
                peer.loopback = `${loopback}:${udp.address().port}`;
                this.emit('join', peer);
                send({ type: 'ready' });
            });
        });
        dc.onMessage((msg) => {
            if (!peer.open || typeof msg === 'string') return;
            udp.send(Buffer.isBuffer(msg) ? msg : Buffer.from(msg), cfg.gamePort, '127.0.0.1');
        });
        dc.onClosed(() => cleanup('canal cerrado'));

        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            try {
                if (msg.type === 'answer' && typeof msg.sdp === 'string') {
                    pc.setRemoteDescription(msg.sdp, 'answer');
                } else if (msg.type === 'candidate' && typeof msg.candidate === 'string' && msg.candidate) {
                    pc.addRemoteCandidate(msg.candidate, msg.mid ?? '0');
                }
            } catch (e) {
                // candidatos mDNS (.local) no resolubles, etc.: se ignoran
                this.emit('debug', `peer ${id}: ${e.message}`);
            }
        });
        // ping periódico: detecta navegadores que se cerraron sin avisar
        let alive = true;
        ws.on('pong', () => { alive = true; });
        heartbeat = setInterval(() => {
            if (!alive) {
                cleanup('sin respuesta');
                return;
            }
            alive = false;
            try { ws.ping(); } catch { /* cerrado */ }
        }, 15000);

        ws.on('close', () => cleanup('websocket cerrado'));
        ws.on('error', () => cleanup('websocket error'));
    }

    closeAll() {
        for (const p of [...this.peers]) p.open = false;
        nodeDataChannel.cleanup();
    }
}

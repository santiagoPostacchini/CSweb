// Red del motor para jugar entre navegadores.
// - Anfitrión: corre un "listen server" en su propia pestaña. Cada jugador remoto llega por su
//   DataChannel y el motor lo ve con una IP ficticia propia (10.77.x.y).
// - Invitado: todo lo que su motor manda a 127.0.0.1:8080 viaja por el DataChannel del anfitrión.
import { ErrNoLocation, Net, Xash3D, type Packet, type Xash3DOptions } from 'xash3d-fwgs';
import { SERVER_IP, SERVER_PORT } from '../engine';

// Puerto en el que el motor abre el socket del servidor (cvar hostport)
const HOST_PORT = 27015;
const REMOTE_CLIENT_PORT = 27005;

class Queue<T> {
    private items: (T | undefined)[];
    private head = 0;
    private tail = 0;
    private count = 0;

    constructor(private readonly max: number) {
        this.items = new Array(max);
    }

    push(item: T) {
        if (this.count === this.max) { // lleno: se descarta el más viejo, como haría UDP
            this.head = (this.head + 1) % this.max;
            this.count--;
        }
        this.items[this.tail] = item;
        this.tail = (this.tail + 1) % this.max;
        this.count++;
    }

    pull(): T | undefined {
        if (!this.count) return undefined;
        const item = this.items[this.head];
        this.items[this.head] = undefined;
        this.head = (this.head + 1) % this.max;
        this.count--;
        return item;
    }
}

// El Net original tiene una sola cola de entrada para todos los sockets; en un listen server
// el socket del cliente local le "robaría" paquetes al del servidor. Acá cada socket lee la suya.
export class RoutedNet extends Net {
    readonly toServer = new Queue<Packet>(4096);
    readonly toClient = new Queue<Packet>(2048);

    recvfrom(fd: number, bufPtr: number, bufLen: number, flags: number, sockaddrPtr: number, socklenPtr: number): number {
        const em = this.em!;
        const port = this.sockets.get(fd)?.addr?.port;
        const packet = (port === HOST_PORT ? this.toServer : this.toClient).pull();
        if (!packet) {
            em.setValue(ErrNoLocation(em), 73, 'i32'); // EWOULDBLOCK
            return -1;
        }
        const data = packet.data as unknown as Uint8Array;
        const copyLen = Math.min(bufLen, data.length);
        if (copyLen > 0) em.HEAPU8.set(data.subarray(0, copyLen), bufPtr);
        if (sockaddrPtr) {
            em.HEAP16[sockaddrPtr >> 1] = 2; // AF_INET
            em.HEAPU8[sockaddrPtr + 2] = (packet.port >> 8) & 0xff;
            em.HEAPU8[sockaddrPtr + 3] = packet.port & 0xff;
            em.HEAPU8.set(packet.ip, sockaddrPtr + 4);
        }
        if (socklenPtr) em.HEAP32[socklenPtr >> 2] = 16;
        return copyLen;
    }
}

type RemotePeer = { id: string; ip: [number, number, number, number]; key: string; channel: RTCDataChannel };

export class Xash3DP2P extends Xash3D {
    readonly rnet: RoutedNet;
    private readonly peersById = new Map<string, RemotePeer>();
    private readonly peersByIp = new Map<string, RemotePeer>();
    private hostChannel?: RTCDataChannel;
    private nextIp = 1;

    constructor(opts: Xash3DOptions, readonly isHost: boolean) {
        super(opts);
        this.net = this.rnet = new RoutedNet(this, { maxPackets: 16 });
    }

    // Llamado por el motor por cada paquete UDP saliente
    sendto(packet: Packet) {
        const data = packet.data as unknown as ArrayBufferView<ArrayBuffer>;
        if (this.isHost) {
            const peer = this.peersByIp.get(packet.ip.join('.'));
            if (peer?.channel.readyState === 'open') peer.channel.send(data);
            return;
        }
        const ch = this.hostChannel;
        if (!ch || ch.readyState !== 'open') return;
        const [a, b, c, d] = packet.ip;
        const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
        if (a === 127 || broadcast) ch.send(data);
    }

    get remotePlayers() {
        return [...this.peersById.values()].filter(p => p.channel.readyState === 'open').length;
    }

    // Anfitrión: un jugador nuevo
    addPeer(id: string, channel: RTCDataChannel) {
        this.removePeer(id);
        const n = this.nextIp++;
        const ip: [number, number, number, number] = [10, 77, (n >> 8) & 0xff, n & 0xff];
        const peer: RemotePeer = { id, ip, key: ip.join('.'), channel };
        channel.binaryType = 'arraybuffer';
        channel.onmessage = (ev) => {
            this.rnet.toServer.push({ data: new Uint8Array(ev.data) as unknown as Int8Array, ip, port: REMOTE_CLIENT_PORT });
        };
        this.peersById.set(id, peer);
        this.peersByIp.set(peer.key, peer);
    }

    removePeer(id: string) {
        const peer = this.peersById.get(id);
        if (!peer) return;
        this.peersById.delete(id);
        this.peersByIp.delete(peer.key);
        try { peer.channel.close(); } catch { /* ya cerrado */ }
    }

    // Invitado: canal hacia el anfitrión
    setHostChannel(channel: RTCDataChannel) {
        channel.binaryType = 'arraybuffer';
        channel.onmessage = (ev) => {
            this.rnet.toClient.push({ data: new Uint8Array(ev.data) as unknown as Int8Array, ip: SERVER_IP, port: SERVER_PORT });
        };
        this.hostChannel = channel;
    }
}

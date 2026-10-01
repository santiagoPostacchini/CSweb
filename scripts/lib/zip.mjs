// Escritor ZIP mínimo (sin data descriptors ni zip64) para que el cliente
// pueda descomprimir en streaming mientras descarga.
import fs from 'node:fs';
import zlib from 'node:zlib';

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

export class ZipWriter {
    constructor(path) {
        this.fd = fs.openSync(path, 'w');
        this.offset = 0;
        this.entries = [];
    }

    write(buf) {
        fs.writeSync(this.fd, buf);
        this.offset += buf.length;
    }

    addFile(name, data, mtime = new Date(), level = 6) {
        const crc = zlib.crc32(data) >>> 0;
        let method = 0;
        let payload = data;
        if (data.length > 64) {
            const deflated = zlib.deflateRawSync(data, { level });
            if (deflated.length < data.length * 0.95) {
                method = 8;
                payload = deflated;
            }
        }
        if (this.offset + payload.length > 0xFFFFFFFF) {
            throw new Error('El paquete supera 4 GB (no soportado sin zip64)');
        }
        const nameBuf = Buffer.from(name, 'utf8');
        const { time, day } = dosDateTime(mtime);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6); // nombres UTF-8
        header.writeUInt16LE(method, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(day, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(payload.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuf.length, 26);
        header.writeUInt16LE(0, 28);
        this.entries.push({ nameBuf, method, time, day, crc, csize: payload.length, usize: data.length, offset: this.offset });
        this.write(header);
        this.write(nameBuf);
        this.write(payload);
    }

    close() {
        const cdStart = this.offset;
        for (const e of this.entries) {
            const h = Buffer.alloc(46);
            h.writeUInt32LE(0x02014b50, 0);
            h.writeUInt16LE(20, 4);
            h.writeUInt16LE(20, 6);
            h.writeUInt16LE(0x0800, 8);
            h.writeUInt16LE(e.method, 10);
            h.writeUInt16LE(e.time, 12);
            h.writeUInt16LE(e.day, 14);
            h.writeUInt32LE(e.crc, 16);
            h.writeUInt32LE(e.csize, 20);
            h.writeUInt32LE(e.usize, 24);
            h.writeUInt16LE(e.nameBuf.length, 28);
            h.writeUInt32LE(e.offset, 42);
            this.write(h);
            this.write(e.nameBuf);
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(this.offset - cdStart, 12);
        end.writeUInt32LE(cdStart, 16);
        this.write(end);
        fs.closeSync(this.fd);
    }
}

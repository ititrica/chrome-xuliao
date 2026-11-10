from pathlib import Path
import struct, zlib

def make(size):
    scale = 4
    n = size * scale
    pixels = []
    def inside(x,y,cx,cy,w,h,r):
        px=max(cx+r-x,0,x-(cx+w-r)); py=max(cy+r-y,0,y-(cy+h-r))
        return cx<=x<cx+w and cy<=y<cy+h and px*px+py*py<=r*r
    for y in range(n):
        row=[]
        for x in range(n):
            a,b=x/n,y/n
            color=(0,0,0,0)
            if inside(a,b,.04,.04,.92,.92,.23): color=(49,93,206,255)
            if inside(a,b,.20,.24,.46,.32,.09) or (.28<a<.37 and .48<b<.64 and b < .64-(a-.28)*.9): color=(255,255,255,255)
            if inside(a,b,.40,.44,.40,.28,.075) or (.65<a<.72 and .64<b<.79 and b<.79-(.72-a)*.8): color=(171,196,255,255)
            row.append(color)
        pixels.append(row)
    data=b''
    for y in range(size):
        data+=b'\x00'
        for x in range(size):
            block=[pixels[y*scale+dy][x*scale+dx] for dy in range(scale) for dx in range(scale)]
            data+=bytes(round(sum(p[k] for p in block)/len(block)) for k in range(4))
    def chunk(tag,d): return struct.pack('>I',len(d))+tag+d+struct.pack('>I',zlib.crc32(tag+d)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(data))+chunk(b'IEND',b'')
    (Path(__file__).resolve().parents[1]/'icons'/f'{size}.png').write_bytes(png)
for size in (16,32,48,128): make(size)

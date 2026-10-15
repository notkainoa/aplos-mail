import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

if(process.platform!=='darwin')throw new Error('Native macOS icon generation requires AppKit and iconutil.');
const source=resolve('assets/icon.svg');
const png=resolve('assets/icon.png');
const icns=resolve('assets/icon.icns');
const temporary=await mkdtemp(join(tmpdir(),'aplos-icon-'));
const iconset=join(temporary,'Aplos.iconset');
try {
  await mkdir(iconset);
  execFileSync('/usr/bin/swift',['-e',`
import AppKit
let source=URL(fileURLWithPath:CommandLine.arguments[1])
let destination=URL(fileURLWithPath:CommandLine.arguments[2])
guard let image=NSImage(contentsOf:source),let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:1024,pixelsHigh:1024,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0),let context=NSGraphicsContext(bitmapImageRep:bitmap) else { fatalError("Could not render original SVG icon") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current=context
image.draw(in:NSRect(x:0,y:0,width:1024,height:1024),from:.zero,operation:.copy,fraction:1)
NSGraphicsContext.restoreGraphicsState()
guard let data=bitmap.representation(using:.png,properties:[:]) else { fatalError("Could not encode icon PNG") }
try data.write(to:destination)
`,source,png],{stdio:'inherit'});
  for(const size of [16,32,128,256,512])for(const scale of [1,2]){
    const physical=size*scale;
    execFileSync('/usr/bin/sips',['-z',String(physical),String(physical),png,'--out',join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{stdio:'ignore'});
  }
  execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',icns],{stdio:'inherit'});
  console.log('Generated original assets/icon.png and assets/icon.icns.');
} finally {await rm(temporary,{recursive:true,force:true});}

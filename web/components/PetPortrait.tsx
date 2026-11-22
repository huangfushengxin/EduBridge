import { useEffect, useRef, type CSSProperties } from "react";
import { pets, type Pet } from "@/lib/study-progress";

const atlas = `${import.meta.env.BASE_URL}pets/companions.png`;
const rows = [{top:28,height:330},{top:371,height:368},{top:750,height:470}];
const cellWidth = 418;

type Point = readonly [number, number];
type Patch = readonly [x: number, y: number, radiusX: number, radiusY: number];
type Face = {
  eyes: readonly [Patch, Patch];
  ears: readonly [Patch, Patch];
  tail: Patch;
  mouth: Point;
  paw: Patch;
  scratch: Point;
};

// Landmarks in the original watercolor atlas, in pet selection and growth order.
const portraits: Face[][] = [
  [
    {eyes:[[212,198,15,13],[258,188,13,13]],ears:[[170,161,31,34],[269,137,25,36]],tail:[149,276,26,28],mouth:[244,215],paw:[254,298,16,13],scratch:[182,191]},
    {eyes:[[223,505,17,15],[271,492,15,14]],ears:[[171,467,34,39],[271,439,28,43]],tail:[134,664,31,33],mouth:[258,526],paw:[227,678,20,16],scratch:[186,496]},
    {eyes:[[233,851,17,15],[277,841,15,15]],ears:[[191,821,38,46],[276,798,31,43]],tail:[116,1130,48,43],mouth:[271,871],paw:[244,1143,22,17],scratch:[198,843]},
  ], [
    {eyes:[[606,191,13,12],[658,182,12,12]],ears:[[562,150,28,27],[669,130,24,27]],tail:[537,267,25,43],mouth:[642,211],paw:[610,298,19,14],scratch:[571,198]},
    {eyes:[[620,501,15,13],[671,486,12,13]],ears:[[568,465,30,38],[674,436,27,38]],tail:[528,572,40,44],mouth:[656,532],paw:[611,681,21,18],scratch:[579,500]},
    {eyes:[[540,844,14,11],[586,851,14,12]],ears:[[529,797,34,40],[614,809,30,37]],tail:[712,879,61,49],mouth:[556,888],paw:[590,1145,23,18],scratch:[506,854]},
  ], [
    {eyes:[[993,198,10,14],[1053,208,13,14]],ears:[[1008,126,31,43],[1081,128,34,47]],tail:[1094,268,23,36],mouth:[1017,231],paw:[1038,300,16,14],scratch:[980,215]},
    {eyes:[[990,515,9,12],[1047,522,14,14]],ears:[[1014,444,31,51],[1091,439,37,53]],tail:[1115,632,32,46],mouth:[1008,552],paw:[1025,681,20,16],scratch:[979,531]},
    {eyes:[[987,881,9,13],[1043,887,14,14]],ears:[[1019,805,31,58],[1090,810,42,61]],tail:[1156,1123,27,42],mouth:[1001,918],paw:[1014,1151,20,16],scratch:[975,893]},
  ],
];

export type PetAction = "wag" | "ears" | "cry" | "puff" | "scratch" | "blink";

function faceInCell(face: Face, left: number, top: number): Face {
  const patch = ([x,y,rx,ry]: Patch): Patch => [x-left,y-top,rx,ry];
  return {
    eyes: [patch(face.eyes[0]),patch(face.eyes[1])],
    ears: [patch(face.ears[0]),patch(face.ears[1])],
    tail: patch(face.tail),
    mouth: [face.mouth[0]-left,face.mouth[1]-top],
    paw: patch(face.paw),
    scratch: [face.scratch[0]-left,face.scratch[1]-top],
  };
}

function bend(source: ImageData, target: ImageData, [cx,cy,rx,ry]: Patch, shiftX: number, shiftY: number, squeeze = 0) {
  const {width,height,data} = source;
  for (let y=Math.max(0,cy-ry); y<Math.min(height,cy+ry); y++) {
    for (let x=Math.max(0,cx-rx); x<Math.min(width,cx+rx); x++) {
      const dy = (y-cy) / ry;
      const radius = ((x-cx) / rx)**2 + dy**2;
      if (radius >= 1) continue;
      const weight = (1-radius)**2;
      const sampleX = Math.min(width-1,Math.max(0,Math.round(x-shiftX*weight)));
      const sampleY = Math.min(height-1,Math.max(0,Math.round(y+weight*(squeeze*(y-cy)-shiftY))));
      const from = (sampleY*width+sampleX)*4;
      const to = (y*width+x)*4;
      target.data[to] = data[from];
      target.data[to+1] = data[from+1];
      target.data[to+2] = data[from+2];
      target.data[to+3] = data[from+3];
    }
  }
}

function pawCutout(skin: CanvasImageSource, [x,y,rx,ry]: Patch, left: number, top: number) {
  const paw = document.createElement("canvas");
  paw.width = 2*rx;
  paw.height = 2*ry;
  const context = paw.getContext("2d");
  if (!context) return paw;
  context.drawImage(skin,left+x-rx,top+y-ry,paw.width,paw.height,0,0,paw.width,paw.height);
  context.globalCompositeOperation = "destination-in";
  const fade = context.createRadialGradient(rx,ry,rx*.48,rx,ry,rx);
  fade.addColorStop(0,"#fff");
  fade.addColorStop(1,"#fff0");
  context.fillStyle = fade;
  context.fillRect(0,0,paw.width,paw.height);
  return paw;
}

const wave = (phase: number, cycles: number) => Math.sin(phase * Math.PI * 2 * cycles) * Math.sin(phase * Math.PI);
const blink = (phase: number) => Math.sin(phase * Math.PI)**4;

function paintMouth(context: CanvasRenderingContext2D, [x,y]: Point, phase: number) {
  const open = Math.sin(phase*Math.PI);
  context.fillStyle = "#764436";
  context.beginPath();
  context.ellipse(x,y,8*open,13*open,0,0,2*Math.PI);
  context.fill();
  context.fillStyle = "#db918a";
  context.beginPath();
  context.ellipse(x,y+5*open,5*open,4*open,0,0,2*Math.PI);
  context.fill();
  for (const offset of [0,.2]) {
    const drift = Math.max(0,(phase-offset)/(1-offset));
    context.fillStyle = `rgba(255,255,255,${Math.sin(drift*Math.PI)*.83})`;
    context.beginPath();
    context.ellipse(x+12+drift*40,y-drift*26,5+drift*16,4+drift*11,-.28,0,2*Math.PI);
    context.fill();
  }
}

function paintTears(context: CanvasRenderingContext2D, eyes: Face["eyes"], phase: number) {
  context.fillStyle = "rgba(119,192,223,.85)";
  for (const [x,y] of eyes) {
    const drop = (phase*2)%1;
    context.beginPath();
    context.ellipse(x,y+12+drop*17,3,5,-.25,0,2*Math.PI);
    context.fill();
  }
}

export function PetPortrait({pet,stage,motion}: {pet:Pet;stage:number;motion?:{action:PetAction;turn:number}}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const row = rows[stage];
  const index = pets.findIndex(({id})=>id===pet);
  const action = motion?.action;
  const turn = motion?.turn;
  const style: CSSProperties = {
    backgroundImage:`url(${atlas})`,
    backgroundSize:`300% ${1254 / row.height * 100}%`,
    backgroundPosition:`${index * 50}% ${row.top / (1254 - row.height) * 100}%`,
    aspectRatio:`${cellWidth} / ${row.height}`,
  };

  useEffect(()=>{
    const element = canvas.current;
    const context = element?.getContext("2d",{willReadFrequently:true});
    if (!element || !context || !action) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const left = index*cellWidth;
    const face = faceInCell(portraits[index][stage],left,row.top);
    const skin = new Image();
    let frame = 0;
    let timer = 0;
    let refreshMotion = () => {};

    skin.onload = ()=>{
      context.drawImage(skin,left,row.top,cellWidth,row.height,0,0,cellWidth,row.height);
      const original = context.getImageData(0,0,cellWidth,row.height);
      const pixels = context.createImageData(cellWidth,row.height);
      const paw = action === "scratch" ? pawCutout(skin,face.paw,left,row.top) : null;

      function animate(cue: PetAction, length: number) {
        const start = performance.now();
        function render(now: number) {
          const phase = Math.min(1,(now-start)/length);
          if (phase===1) {
            context!.putImageData(original,0,0);
            idle();
            return;
          }

          pixels.data.set(original.data);
          if (cue==="wag") {
            const sway = wave(phase,3);
            bend(original,pixels,face.tail,18*sway,15*sway);
          }
          if (cue==="ears") {
            bend(original,pixels,face.ears[0],20*wave(phase,2),-8*wave(phase,2));
            bend(original,pixels,face.ears[1],-18*wave(phase,2),-7*wave(phase,2));
          }
          const squint = cue==="blink" ? blink(phase) : cue==="cry" || cue==="puff" ? .72*Math.sin(phase*Math.PI) : 0;
          if (squint>0) {
            for (const eye of face.eyes) bend(original,pixels,eye,0,0,squint*7);
          }

          context!.putImageData(pixels,0,0);
          if (cue==="cry") paintTears(context!,face.eyes,phase);
          if (cue==="puff") paintMouth(context!,face.mouth,phase);
          if (cue==="scratch" && paw) {
            const [x,y,rx,ry] = face.paw;
            const [headX,headY] = face.scratch;
            const lift = Math.min(1,phase*5,(1-phase)*5);
            const swipe = lift*wave(phase,4);
            context!.save();
            context!.globalAlpha = Math.min(1,lift*3);
            context!.translate(x+(headX-x)*lift-12*swipe,y+(headY-y)*lift+9*swipe);
            context!.rotate(-.42*lift+.24*swipe);
            context!.drawImage(paw,-rx,-ry);
            context!.restore();
          }
          frame = requestAnimationFrame(render);
        }
        frame = requestAnimationFrame(render);
      }

      function idle() {
        timer = window.setTimeout(()=>animate("blink",270),3000);
      }

      refreshMotion = ()=>{
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
        context.putImageData(original,0,0);
        if (reduced.matches) return;
        animate(action,action==="blink" ? 480 : 1300);
      };
      refreshMotion();
    };
    const updatePreference = () => refreshMotion();
    reduced.addEventListener("change",updatePreference);
    skin.src = atlas;
    return ()=>{
      skin.onload = null;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      reduced.removeEventListener("change",updatePreference);
    };
  },[action,turn,index,row,stage]);

  return <span className="workspace-pet-art" aria-hidden="true" style={style}>
    {motion && <canvas ref={canvas} className="workspace-pet-canvas" width={cellWidth} height={row.height} />}
  </span>;
}

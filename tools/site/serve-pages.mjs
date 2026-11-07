import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, dirname, relative, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../dist/pages");
const mime={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".wasm":"application/wasm",".svg":"image/svg+xml"};
createServer(async(req,res)=>{try{
 const url=new URL(req.url??"/","http://localhost");
 if(url.pathname==="/teldra"){res.writeHead(302,{location:"/teldra/"}).end();return;}
 if(!url.pathname.startsWith("/teldra/")){res.writeHead(404).end();return;}
 let path=resolve(root,decodeURIComponent(url.pathname.slice(8))||"index.html");
 if(relative(root,path).startsWith("..")){res.writeHead(403).end();return;}
 if((await stat(path)).isDirectory())path=join(path,"index.html");
 res.writeHead(200,{"content-type":mime[extname(path)]??"application/octet-stream","cache-control":"no-store"});
 createReadStream(path).pipe(res);
}catch{res.writeHead(404).end();}}).listen(Number(process.argv[2]??4174),"127.0.0.1",()=>console.log("Pages preview ready"));

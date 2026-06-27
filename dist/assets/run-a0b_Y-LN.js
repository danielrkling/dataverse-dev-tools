const a={name:"run",commands:[{name:"run",description:"Execute a JavaScript file in the terminal context",usage:"run <file>",handler:async(n,u,{fs:r})=>{if(!n[0])return"Usage: run <file>";try{const e=await r.readFile(n[0],{encoding:"utf8"}),t=await new Function(`
            const module = { exports: {} };
            const exports = module.exports;
            return (async () => {
              ${e}
              return module.exports;
            })();
          `)();return t!==void 0?String(t):""}catch(e){return`run: ${e.message}`}}}]};export{a as default};

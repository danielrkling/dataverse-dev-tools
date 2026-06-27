const r={name:"builtin",commands:[{name:"help",aliases:["?"],description:"Show available commands or details about a specific command",usage:"help [command]",handler:(a,n,{pm:i})=>{if(a.length>0){const e=i.registry.resolve(a[0]);if(e){const s=[`${e.name} — ${e.description}`];return e.usage&&s.push(`Usage: ${e.usage}`),e.aliases.length&&s.push(`Aliases: ${e.aliases.join(", ")}`),n.log(s.join(`
`)),""}return n.log(`No help found for '${a[0]}'`,{class:"log-error"}),""}const l=i.registry.list(),o=l.map(e=>`  ${e.name.padEnd(15)} ${e.description}`);return n.log(`Available commands (${l.length}):
${o.join(`
`)}`),""}},{name:"clear",description:"Clear the terminal screen",handler:(a,n)=>(n.clear(),"")}]};export{r as default};

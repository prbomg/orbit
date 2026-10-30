/** Move within one visible group, retaining other groups and hidden projects. */
function moveProject(items, source, target) {
 const from=items.findIndex(item=>item.id===source), to=items.findIndex(item=>item.id===target);
 if(from<0||to<0||from===to||Boolean(items[from].archivedAt)!==Boolean(items[to].archivedAt))return items;
 const next=[...items], [item]=next.splice(from,1);next.splice(to,0,item);return next;
}
async function saveProjectOrder(tx, ids, archived) {
 if(new Set(ids).size!==ids.length)throw new Error('invalid_order');
 const current=await tx.project.findMany({where:archived?{archivedAt:{not:null}}:{archivedAt:null},select:{id:true}});
 const allowed=new Set(current.map(item=>item.id));
 if(ids.length!==current.length||ids.some(id=>!allowed.has(id)))throw new Error('order_changed');
 for(const [sortOrder,id] of ids.entries())await tx.project.update({where:{id},data:{sortOrder}});
}
module.exports={moveProject,saveProjectOrder};

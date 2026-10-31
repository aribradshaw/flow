// Workspace workflow labels keep stable ids so saved items, cards and automation still work.
export const STATUS_DEFAULTS={planned:'Planned',active:'In progress',risk:'At risk',blocked:'Blocked',done:'Done',cancelled:'Cancelled'};
export const WORKFLOW_PRESETS={
  delivery:{name:'Delivery',statuses:{...STATUS_DEFAULTS},columns:{requests:'Requests / Sprinted',doing:'Doing',blocked:'Blocked',uat:'UAT',done:'Done',must:'Backlog: Must Have',nice:'Backlog: Nice to Have'}},
  simple:{name:'Simple',statuses:{planned:'To do',active:'In progress',risk:'Needs attention',blocked:'Blocked',done:'Done',cancelled:'Dropped'},columns:{requests:'To do',doing:'In progress',blocked:'Blocked',uat:'Review',done:'Done',must:'Later',nice:'Ideas'}},
  planning:{name:'Planning',statuses:{planned:'Idea',active:'Exploring',risk:'Needs decision',blocked:'Waiting',done:'Resolved',cancelled:'Archived'},columns:{requests:'Inbox',doing:'Exploring',blocked:'Waiting',uat:'Review',done:'Resolved',must:'Next',nice:'Someday'}},
};
export function cleanWorkflow(value){
  const preset=WORKFLOW_PRESETS[value?.preset]?value.preset:'delivery';
  const defaults=WORKFLOW_PRESETS[preset].statuses;
  const statuses=Object.fromEntries(Object.keys(STATUS_DEFAULTS).map(id=>{
    const name=value?.statuses?.[id];
    return [id,typeof name==='string'&&name.trim()?name.trim().slice(0,40):defaults[id]];
  }));
  return {preset,statuses};
}

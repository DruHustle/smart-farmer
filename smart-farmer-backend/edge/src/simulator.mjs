export const protocolCapabilities = Object.freeze({
  simulator: {implemented: true, telemetry: ['running', 'interlock_ok'], commands: ['start', 'stop']},
  mqtt: {implemented: false, reason: 'Requires commissioned topic mapping, authentication and hardware verification'},
  http: {implemented: false, reason: 'Requires commissioned endpoint mapping, authentication and hardware verification'},
  modbus: {implemented: false, reason: 'Requires model-specific register map, serial/TCP configuration and local interlocks'}
});

export function decideCommand(command, state, now=Date.now()) {
  if(!command || typeof command.id!=='string' || !/^[0-9a-f-]{36}$/i.test(command.id))return {status:'rejected',reason:'invalid_command'};
  if(command.source!=='simulator' || !['start','stop'].includes(command.command))return {status:'rejected',reason:'unsupported_command'};
  if(!Number.isFinite(Date.parse(command.expiresAt)) || Date.parse(command.expiresAt)<=now)return {status:'rejected',reason:'expired'};
  if(state.executions.some(item=>item.id===command.id))return {status:'rejected',reason:'already_processed'};
  if(command.command==='start' && state.interlockOk!==true)return {status:'rejected',reason:'local_interlock_open'};
  return {status:'confirmed',feedback:{running:command.command==='start',interlock_ok:state.interlockOk}};
}

export function applyDecision(command,state,decision) {
  if(decision.status!=='confirmed')return state;
  return {...state,running:decision.feedback.running,executions:[...state.executions,{id:command.id,expiresAt:command.expiresAt}].slice(-1000)};
}

export function enqueueObservation(state,observation,limit=1000) {
  const buffer=[...state.buffer,observation];
  const dropped=Math.max(0,buffer.length-limit);
  return {...state,buffer:buffer.slice(-limit),droppedObservations:(state.droppedObservations||0)+dropped};
}

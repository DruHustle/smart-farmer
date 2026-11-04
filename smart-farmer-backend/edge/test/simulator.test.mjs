import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applyDecision,decideCommand,enqueueObservation,protocolCapabilities} from '../src/simulator.mjs';

test('expired, unsupported, interlocked and replayed starts never execute',()=>{
 const now=Date.now();const command={id:randomUUID(),source:'simulator',command:'start',expiresAt:new Date(now+10000).toISOString()};
 const state={running:false,interlockOk:true,executions:[],buffer:[]};
 assert.equal(decideCommand({...command,expiresAt:new Date(now).toISOString()},state,now).reason,'expired');
 assert.equal(decideCommand({...command,source:'modbus'},state,now).reason,'unsupported_command');
 assert.equal(decideCommand(command,{...state,interlockOk:false},now).reason,'local_interlock_open');
 const decision=decideCommand(command,state,now);assert.equal(decision.status,'confirmed');
 const changed=applyDecision(command,state,decision);assert.equal(changed.running,true);
 assert.equal(decideCommand(command,JSON.parse(JSON.stringify(changed)),now).reason,'already_processed');
 assert.equal(applyDecision(command,state,{status:'rejected'}),state);
});
test('buffer keeps original event IDs/times and reports bounded loss',()=>{
 const first={id:randomUUID(),observedAt:'2026-01-01T00:00:00Z'};
 let state={buffer:[],droppedObservations:0};state=enqueueObservation(state,first,2);
 state=enqueueObservation(state,{id:randomUUID()},2);assert.deepEqual(state.buffer[0],first);
 state=enqueueObservation(state,{id:randomUUID()},2);assert.equal(state.buffer.length,2);assert.equal(state.droppedObservations,1);
 assert.equal(protocolCapabilities.modbus.implemented,false);assert.equal(protocolCapabilities.simulator.implemented,true);
});

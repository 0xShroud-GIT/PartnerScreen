import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeControlMessage, encodeControlMessage } from '../src/protocol/ControlCodec';
import type { AnyControlMessage } from '../src/protocol/ControlMessage';

const base={version:1 as const,messageId:'55555555-5555-4555-8555-555555555555',sessionId:'33333333-3333-4333-8333-333333333333',senderDeviceId:'22222222-2222-4222-8222-222222222222',sequence:1,timestamp:'2026-08-19T00:00:00.000Z'};
const sdp='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n';
const candidate='candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0';

test('M6 video SDP round-trips through the authenticated control codec',()=>{const m={...base,type:'SDP_OFFER',payload:{sdp}} as AnyControlMessage; assert.deepEqual(decodeControlMessage(encodeControlMessage(m)),m);});
test('M6 rejects audio, STUN/TURN and oversized SDP',()=>{for(const bad of [sdp+'m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',sdp+'a=ice-server:turn:relay.example\r\n','m=video '+ 'x'.repeat(13*1024)]) assert.throws(()=>decodeControlMessage(JSON.stringify({...base,type:'SDP_OFFER',payload:{sdp:bad}})),/SDP_OFFER payload/i);});
test('M6 accepts only bounded private IPv4 host ICE candidates',()=>{const good={...base,type:'ICE_CANDIDATE',payload:{sdpMid:'0',sdpMLineIndex:0,candidate}} as AnyControlMessage; assert.deepEqual(decodeControlMessage(encodeControlMessage(good)),good); for(const bad of ['candidate:1 1 udp 1 8.8.8.8 50000 typ host','candidate:1 1 udp 1 192.168.1.20 50000 typ relay','candidate:1 1 udp 1 relay.local 50000 typ host']) assert.throws(()=>decodeControlMessage(JSON.stringify({...good,payload:{...good.payload,candidate:bad}})),/ICE_CANDIDATE payload/i);});
test('M7 restart request is a strict authenticated control message',()=>{const restart={...base,type:'MEDIA_RESTART_REQUEST',payload:{reason:'connection_lost'}} as AnyControlMessage; assert.deepEqual(decodeControlMessage(encodeControlMessage(restart)),restart); assert.throws(()=>decodeControlMessage(JSON.stringify({...restart,payload:{reason:'network_changed'}})),/MEDIA_RESTART_REQUEST payload/i); assert.throws(()=>decodeControlMessage(JSON.stringify({...restart,payload:{reason:'connection_lost',attempt:1}})),/MEDIA_RESTART_REQUEST payload/i);});

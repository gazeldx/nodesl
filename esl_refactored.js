'use strict';

let config = require('./config');
let FreeSwitch = require('./FreeSwitch');

let esl = require('modesl');
let util = require('util');
let http = require('http');
let faye = require('faye');
let _ = require('underscore')._;
let moment = require('moment');

let bayeux = new faye.NodeAdapter({
  mount: '/faye',
  timeout: 45,
});

let server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
  });
  return res.end('Hello, non-Bayeux request');
});

const apiEventMap = {
  api_begin: 'started',
  checkagent: 'agentReady',
  callbleg: 'callCallee',
  callbleg_ringback: 'calleeRingBack',
  callbleg_answer: 'calleeAnswered',
  api_end: 'processed',
};
const maxCallCount = 10000;
let currentCalls = {};

let listenEvents = function eventsListening(freeSwitch) {
  listenCustomEvent(freeSwitch);

  listenHeartbeatEvent(freeSwitch);

  listenHangupEvent(freeSwitch);
};

let apiAgentState = function stateOfApiAgent(eventName, result) {
  if (eventName === 'callaleg') {
    if (result === 'start') {
      return 'callAgentStarted';
    } else if (result === 'success') {
      return 'callAgentSuccess';
    } else if (result === 'fail') {
      return 'callAgentFailed';
    } else {
      return eventName;
    }
  } else {
    return apiEventMap[eventName] || eventName;
  }
};

let webCallMessage = function messageOfWebCall(headers) {
  return {
    callId: headers['callid'],
    callerNumber: headers['caller_number'],
    calleeNumber: headers['callee_number'],
    agentId: Number(headers['agent_id']),
    salesmanCode: (headers['salesman_code'] === 'null' ? undefined : headers['salesman_code']),
    state: apiAgentState(event.subclass.replace('webcallapi::', ''), headers['result']),
    updatedAt: Date.now(),
  }
};

let logFreeSwitchDetail = function logFreeSwitchInfo() {
  const freeSwitchesLog = _.map(config.freeSwitches, (freeSwitch) => {
    return _.pick(freeSwitch, 'host', 'lastTryConnectAt', 'lastAliveAt', 'breakdownLast', 'currentReconnectCount', 'allReconnectCount');
  });

  console.log(`>>>> ${moment().format('YYYY-MM-DD HH:mm:ss')} FreeSwitches: ${util.inspect(freeSwitchesLog, { showHidden: true, depth: 1 })}`);
};

let reconnectFreeSwitchIfNeed = function reconnectFreeSwitchWhenNeed() {
  _.each(config.freeSwitches, (freeSwitch) => {
    if (freeSwitch.needReconnect()) {
      freeSwitch.connectEsl();

      listenEvents(freeSwitch);
    }

    freeSwitch.breakdownLast = freeSwitch.breakdownLasted();
  });

  logFreeSwitchDetail();
};

let deleteDeadCalls = function destroyDeadCalls() {
  const currentCallsKeys = _.keys(currentCalls);

  _.each(currentCallsKeys, (callKey) => {
    if (currentCalls[callKey].state === 'calleeAnswered') {
      if (Date.now() - currentCalls[callKey].updatedAt > 2 * 60 * 60 * 1000) { // Duration exceed two hours, means this call is dead.
        delete currentCalls[callKey];
      }
    } else {
      if (Date.now() - currentCalls[callKey].updatedAt > 60 * 1000) { // 60 seconds no answer call is dead.
        delete currentCalls[callKey];
      }
    }
  })
};

let limitCallCount = function limitCallCount() {
  const currentCallsKeys = _.keys(currentCalls);

  if (currentCallsKeys.length > maxCallCount) {
    currentCalls = _.omit(currentCalls, _.shuffle(currentCallsKeys).slice(0, currentCallsKeys.length - maxCallCount));

    console.log(`>>>> ${moment().format('YYYY-MM-DD HH:mm:ss')} Current call count ${maxCallCount} exceeded maximum. We have deleted ${currentCallsKeys.length - maxCallCount} calls randomly.`);
  }

  console.log(`~~~~~ current call count is ${_.keys(currentCalls).length} ~~~~~`);
};

let maintainCurrentCalls = function updateCurrentCalls() {
  deleteDeadCalls();

  limitCallCount();
};

let simpleHeaders = function simplenessHeaders(headers) {
  let headersHash = {};

  _.map(headers, (header) => {
    return headersHash[header.name] = header.value;
  });

  return headersHash;
};

let listenCustomEvent = function customEventListening(freeSwitch) {
  freeSwitch.connection.on('esl::event::CUSTOM::*', (event) => {
    console.log(`==== ${moment().format('YYYY-MM-DD HH:mm:ss')} Received CUSTOM::* from FreeSwitch ${freeSwitch.host} ====`);

    if (event.subclass === 'acdqueue::info') {
      const headers = simpleHeaders(event.headers);

      if (_.contains(['agent-status-change', 'agent-state-change', 'agent-sign-change'], headers['AQ-Action'])) {
        bayeux.getClient().publish('/monitor_agents_' + headers['AQ-Agent'].slice(0, 5), headers);
      }
    } else if ((event.subclass || '').startsWith('webcallapi::')) {
      const headers = simpleHeaders(event.headers);

      if (!_.isEmpty(headers['agent_id'])) {
        const message = webCallMessage(headers);

        if (event.subclass === 'webcallapi::api_begin') {
          if (_.has(headers, 'callid')) {
            currentCalls[headers['callid']] = message;
          }
        } else if (event.subclass === 'webcallapi::callbleg_answer') {
          if (_.has(currentCalls, headers['callid'])) {
            currentCalls[headers['callid']].state = apiEventMap['callbleg_answer'];
          }
        }

        bayeux.getClient().publish('/monitor_agent_' + headers['agent_id'], message);
      }
    }
  });
};

let listenHeartbeatEvent = function heartbeatEventListening(freeSwitch) {
  freeSwitch.connection.on('esl::event::HEARTBEAT::*', (event) => {
    updateAliveTime(freeSwitch);

    console.log(`==== ${moment().format('YYYY-MM-DD HH:mm:ss')} HEARTBEAT received from FreeSwitch ${freeSwitch.host} ====`);
  });
};

let listenHangupEvent = function hangupEventListening(freeSwitch) {
  freeSwitch.connection.on('esl::event::CHANNEL_HANGUP::*', (event) => {
    const headers = simpleHeaders(event.headers);
    let call = currentCalls[headers['Other-Leg-Unique-ID']];

    if (!_.isEmpty(call)) {
      if (call.agentId > 0) {
        call.state = 'hangup';
        bayeux.getClient().publish('/monitor_agent_' + call.agentId, call);
      }

      delete currentCalls[headers['Other-Leg-Unique-ID']];
    }
  });
};

bayeux.on('handshake', (clientId) => {
  return console.log('bayeux.on handshake ', clientId);
});

bayeux.on('subscribe', (clientId, channel) => {
  return console.log('bayeux.on subscribe ', clientId, channel);
});

bayeux.on('publish', (clientId, channel, data) => {
  return console.log('bayeux.on publish ', clientId, channel, data);
});

bayeux.attach(server);

server.listen(config.web.port);

console.log(`====== ${moment().format('YYYY-MM-DD HH:mm:ss')} ESL Server has been started on ${config.web.port} ======`);

config.freeSwitches = _.map(config.freeSwitches, (freeSwitchConfig) => {
  return new FreeSwitch(freeSwitchConfig).connectEsl();
});

_.each(config.freeSwitches, (freeSwitch) => {
  freeSwitch.allReconnectCount = 0;

  freeSwitch.updateAliveTime();

  listenEvents(freeSwitch);
});

setInterval(reconnectFreeSwitchIfNeed, 1 * 60 * 1000);

setInterval(maintainCurrentCalls, 20 * 1000);
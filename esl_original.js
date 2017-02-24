var config = require('./config');

var esl = require('modesl');
var util = require('util');
var http = require('http');
var faye = require('faye');
var _ = require('underscore')._;
var moment = require('moment');

var bayeux = new faye.NodeAdapter({
  mount: '/faye',
  timeout: 45
});

bayeux.on('handshake', function(clientId) {
  return console.log('bayeux.on handshake ', clientId);
});

bayeux.on('subscribe', function(clientId, channel) {
  return console.log('bayeux.on subscribe ', clientId, channel);
});

bayeux.on('publish', function(clientId, channel, data) {
  //return console.log('bayeux.on publish ', clientId, channel, data);
  return;
});

var server = http.createServer(function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain'
  });
  return res.end('Hello, non-Bayeux request');
});

bayeux.attach(server);

server.listen(config.web.port);

console.log('====== ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' ESL Server started and is listening on', config.web.port, '======');

var updateAliveTime = function (freeSwitch) {
  freeSwitch.lastAliveTime = moment();
  freeSwitch.lastAliveAt = freeSwitch.lastAliveTime.format("YYYY-MM-DD HH:mm:ss");
  freeSwitch.currentReconnectCount = 0;
  return ;
};

var apiCallEventNames = ['api_begin', 'checkagent', 'callaleg', 'callbleg', 'callbleg_ringback', 'callbleg_answer', 'api_end'];
var apiEventMap = {
  'api_begin': 'started',
  'checkagent': 'agentReady',
  'callbleg': 'callCallee',
  'callbleg_ringback': 'calleeRingBack',
  'callbleg_answer': 'calleeAnswered',
  'api_end': 'processed'
};
var currentCalls= {};

var newFreeSwitchConnection = function (freeSwitch) {
  var freeSwitchConnection = new esl.Connection(freeSwitch.host, freeSwitch.port, 'ccc', function () {
    freeSwitch.connection.subscribe('CUSTOM acdqueue::info', function (res) {
      console.log('#### ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' FS: ' + freeSwitch.host + ' subscribe "CUSTOM acdqueue::info" event res: ' + res);
    });

    _.each(apiCallEventNames, function (apiCallEventName) {
      freeSwitch.connection.subscribe('CUSTOM webcallapi::' + apiCallEventName, function (res) {
        console.log('#### ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' FS: ' + freeSwitch.host + ' subscribe "CUSTOM webcallapi::' + apiCallEventName + '" event res: ' + res);
      });
    });

    freeSwitch.connection.events('plain', 'HEARTBEAT', function (res) {
      console.log('#### ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' FS: ' + freeSwitch.host + ' subscribe HEARTBEAT event res: ' + res);
    });

    freeSwitch.connection.events('plain', 'CHANNEL_HANGUP', function (res) {
      console.log('#### ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' FS: ' + freeSwitch.host + ' subscribe CHANNEL_HANGUP event res: ' + res);
    });
  });

  return freeSwitchConnection;
};

var listenEvents = function (freeSwitch) {
  freeSwitch.connection.on('esl::event::CUSTOM::*', function(event) {
    //console.log('==== ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' Received CUSTOM::* from FS: ' + freeSwitch.host + ' ====');
    //console.log(event);

    if (event.subclass === 'acdqueue::info') {
      var headers = simpleHeaders(event.headers);
      if (_.contains(['agent-status-change', 'agent-state-change', 'agent-sign-change'], headers['AQ-Action'])) {
        bayeux.getClient().publish('/monitor_agents_' + headers['AQ-Agent'].slice(0, 5), headers);
      }
    } else if ((event.subclass || '').startsWith('webcallapi::')) {
      var headers = simpleHeaders(event.headers);
      if (!_.isEmpty(headers['agent_id'])) {
        var message = {
          callId: headers['callid'],
          callerNumber: headers['caller_number'],
          calleeNumber: headers['callee_number'],
          agentId: Number(headers['agent_id']),
          salesmanCode: (headers['salesman_code'] === 'null' ? undefined : headers['salesman_code']),
          state: apiAgentState(event.subclass.replace('webcallapi::', ''), headers['result']),
          updatedAt: Date.now()
        };

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

  freeSwitch.connection.on('esl::event::HEARTBEAT::*', function(event) {
    updateAliveTime(freeSwitch);

    console.log('==== ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' HEARTBEAT received from FS: ' + freeSwitch.host + ' ====');
  });

  freeSwitch.connection.on('esl::event::CHANNEL_HANGUP::*', function(event) {
    var headers = simpleHeaders(event.headers);
    var call = currentCalls[headers['Other-Leg-Unique-ID']];
    if (!_.isEmpty(call)) {
      if (call.agentId > 0) {
        call.state = 'hangup';
        bayeux.getClient().publish('/monitor_agent_' + call.agentId, call);
      }
      delete currentCalls[headers['Other-Leg-Unique-ID']];
    }
  });

  return ;
};

var connectFreeSwitch = function (freeSwitch) {
  freeSwitch.allReconnectCount = freeSwitch.allReconnectCount + 1;
  freeSwitch.currentReconnectCount = freeSwitch.currentReconnectCount + 1;
  freeSwitch.lastTryConnectTime = moment();
  freeSwitch.lastTryConnectAt = freeSwitch.lastTryConnectTime.format("YYYY-MM-DD HH:mm:ss");

  return _.extend(freeSwitch, {
    connection: newFreeSwitchConnection(freeSwitch)
  });
};

config.freeSwitches = _.map(config.freeSwitches, function (freeSwitch) {
  return connectFreeSwitch(freeSwitch);
});

_.each(config.freeSwitches, function (freeSwitch) {
  freeSwitch.allReconnectCount = 0;
  updateAliveTime(freeSwitch);

  listenEvents(freeSwitch);
});

var simpleHeaders = function (header) {
  var result_hash = {};

  _.map(header, function(h) {
    return result_hash[h.name] = h.value;
  });

  return result_hash;
};

var apiAgentState = function(name, result) {
  if (name === 'callaleg') {
    if (result === 'start') {
      return 'callAgentStarted';
    } else if (result === 'success') {
      return 'callAgentSuccess';
    } else if (result === 'fail') {
      return 'callAgentFailed';
    } else {
      return name;
    }
  } else {
    return apiEventMap[name] || name;
  }
};

setInterval(function() {
  var period = (moment() > moment("08", "hh") && moment() < moment("20", "hh")) ? 2 : 5;

  _.each(config.freeSwitches, function (freeSwitch) {
    if (((moment() - moment.max(freeSwitch.lastAliveTime, freeSwitch.lastTryConnectTime)) / (1000 * 60)) > period) {
      connectFreeSwitch(freeSwitch);

      listenEvents(freeSwitch);
    }

    freeSwitch.freeSwitchBreakdownLasted = (freeSwitch.currentReconnectCount > 0 ? ((moment() - freeSwitch.lastAliveTime) / (1000 * 60)).toFixed(2) : '0') + ' minutes';
  });

  var freeSwitchesForLog = _.map(config.freeSwitches, function (freeSwitch) {
    return _.pick(freeSwitch, 'host', 'lastTryConnectAt', 'lastAliveAt', 'freeSwitchBreakdownLasted', 'currentReconnectCount', 'allReconnectCount');
  });

  console.log('>>>> ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' config.freeSwitches: ', util.inspect(freeSwitchesForLog, { showHidden: true, depth: 1 }));
}, 1 * 60 * 1000);

//用于维护currentCalls
setInterval(function() {
  var currentCallsKeys = _.keys(currentCalls);
  var maxCount = 10000;

  //删除过时的记录
  _.each(currentCallsKeys, function(callKey) {
    if (currentCalls[callKey].state === 'calleeAnswered') { //answer了，但时长超过两个小时，可以删除
      if (Date.now() - currentCalls[callKey].updatedAt > 2 * 60 * 60 * 1000) {
        delete currentCalls[callKey];
      }
    } else {
      if (Date.now() - currentCalls[callKey].updatedAt > 60 * 1000) { //时长超过60秒未answer，可以删除
        delete currentCalls[callKey];
      }
    }
  });

  //keys数量小于指定值，防止currentCalls过大
  if (currentCallsKeys.length > maxCount) {
    currentCalls = _.omit(currentCalls, _.shuffle(currentCallsKeys).slice(0, currentCallsKeys.length - maxCount));
    console.log('>>>> ' + moment().format("YYYY-MM-DD HH:mm:ss") + ' 呼叫记录数超过了' + maxCount + '，系统随机删除了' + (currentCallsKeys.length - maxCount) + '个呼叫记录。');
  }
  console.log("~~~~~~~~~~~~ currentCalls keys count is " + _.keys(currentCalls).length + " ~~~~~~~~~~~~");
  console.log(currentCalls);
}, 1 * 20 * 1000);
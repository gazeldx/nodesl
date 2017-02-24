'use strict';

let esl = require('modesl');
let _ = require('underscore')._;
let moment = require('moment');
let config = require('./config');

class FreeSwitch {
  constructor(freeSwitchConfig) {
    this.serverConfig = freeSwitchConfig;
  }

  newEslConnection() {
    return new esl.Connection(this.serverConfig.host, this.serverConfig.port, this.serverConfig.password, () => {
      this.connection.subscribe('CUSTOM acdqueue::info', (res) => {
        this.logEvent(this, res,     'CUSTOM acdqueue::info');
      });

      _.each(['api_begin', 'checkagent', 'callaleg', 'callbleg', 'callbleg_ringback', 'callbleg_answer', 'api_end'], (apiCallEventName) => {
        this.connection.subscribe('CUSTOM webcallapi::' + apiCallEventName, (res) => {
          this.logEvent(res,      'CUSTOM webcallapi::' + apiCallEventName);
        })
      });

      this.connection.events('plain', 'HEARTBEAT', (res) => {
        this.logEvent(res,            'HEARTBEAT');
      });

      this.connection.events('plain', 'CHANNEL_HANGUP', (res) => {
        this.logEvent(res,            'CHANNEL_HANGUP');
      })
    })
  }

  connectEsl() {
    this.allReconnectCount = this.allReconnectCount + 1;
    this.currentReconnectCount = this.currentReconnectCount + 1;
    this.lastTryConnectTime = moment();
    this.lastTryConnectAt = this.lastTryConnectTime.format('YYYY-MM-DD HH:mm:ss');

    return _.extend(this, {
      connection: this.newEslConnection(),
    });
  }

  updateAliveTime() {
    this.lastAliveTime = moment();
    this.lastAliveAt = this.lastAliveTime.format('YYYY-MM-DD HH:mm:ss');
    this.currentReconnectCount = 0;
  }

  logEvent(res, eventName) {
    console.log(`#### ${moment().format('YYYY-MM-DD HH:mm:ss')} The response of subscribing FreeSwitch ${this.serverConfig.host} event "${eventName}" is: ${res}`);
  }

  needReconnect() {
    const reconnectInterval = 5 * 60 * 1000;
    return (moment() - moment.max(this.lastAliveTime, this.lastTryConnectTime)) > reconnectInterval;
  }

  breakdownLasted() {
    let breakdownMinutes = '0';
    if (this.currentReconnectCount > 0) {
      breakdownMinutes = ((moment() - this.lastAliveTime) / (1000 * 60)).toFixed(2);
    }
    return breakdownMinutes + ' minutes';
  }
}

module.exports = FreeSwitch;
const rpio = require('rpio');
const dhtSensor = require('node-dht-sensor');

let Service, Characteristic, HeatingCoolingStateToRelayPin;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-pi-thermostat', 'Thermostat', Thermostat);
};

class Thermostat {
  constructor(log, config) {
    this.log = log;
    this.maxTemp = 30;
    this.minTemp = 0;
    this.name = config.name;

    this.fanRelayPin = config.fanRelayPin || 26;
    this.heatRelayPin = config.heatRelayPin || 27;
    this.coolRelayPin = config.coolRelayPin || 28;
    this.temperatureSensorPin = config.temperatureSensorPin || 4;
    this.minimumOnOffTime = config.minimumOnOffTime || 60000; // In milliseconds
    this.temperatureCheckInterval = config.temperatureCheckInterval || 10000; // In milliseconds

    HeatingCoolingStateToRelayPin = {
      [Characteristic.CurrentHeatingCoolingState.HEAT]: this.heatRelayPin,
      [Characteristic.CurrentHeatingCoolingState.COOL]: this.coolRelayPin
    };

    rpio.open(this.fanRelayPin, rpio.OUTPUT, rpio.LOW);
    rpio.open(this.heatRelayPin, rpio.OUTPUT, rpio.LOW);
    rpio.open(this.coolRelayPin, rpio.OUTPUT, rpio.LOW);

    this.currentTemperature = 21;
    this.currentRelativeHumidity = 50;
    this.targetTemperature = 21;

    this.heatingThresholdTemperature = 18;
    this.coolingThresholdTemperature = 24;
      
    //Characteristic.TemperatureDisplayUnits.CELSIUS = 0;
    //Characteristic.TemperatureDisplayUnits.FAHRENHEIT = 1;
    this.temperatureDisplayUnits = Characteristic.TemperatureDisplayUnits.CELSIUS;
  
    // The value property of CurrentHeatingCoolingState must be one of the following:
    //Characteristic.CurrentHeatingCoolingState.OFF = 0;
    //Characteristic.CurrentHeatingCoolingState.HEAT = 1;
    //Characteristic.CurrentHeatingCoolingState.COOL = 2;
    this.currentHeatingCoolingState = Characteristic.CurrentHeatingCoolingState.OFF;
  
    // The value property of TargetHeatingCoolingState must be one of the following:
    //Characteristic.TargetHeatingCoolingState.OFF = 0;
    //Characteristic.TargetHeatingCoolingState.HEAT = 1;
    //Characteristic.TargetHeatingCoolingState.COOL = 2;
    //Characteristic.TargetHeatingCoolingState.AUTO = 3;
    this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.OFF;
  
    this.service = new Service.Thermostat(this.name);

    this.setupTemperatureCheckInterval();
  }

  identify(callback) {
    this.log('Identify requested!');
    callback(null);
  }

  get currentlyRunning() {
    if (this.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.HEAT) {
      return 'Heat';
    } else if (this.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.COOL) {
      return 'Cool';
    } else {
      return 'Off';
    }
  }

  get shouldTurnOnHeating() {
    return (this.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.HEAT && this.currentTemperature < this.targetTemperature)
      || (this.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.AUTO && this.currentTemperature < this.heatingThresholdTemperature);
  }

  get shouldTurnOnCooling() {
    return (this.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.COOL && this.currentTemperature > this.targetTemperature)
      || (this.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.AUTO && this.currentTemperature > this.coolingThresholdTemperature);
  }

  turnOnSystem(systemToTurnOn) {
    if (this.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.OFF) {
      this.log(`START ${systemToTurnOn}`);
      rpio.write(HeatingCoolingStateToRelayPin[systemToTurnOn], rpio.HIGH);
      this.systemStartTime = new Date();
      this.service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
    } else if (this.currentHeatingCoolingState !== systemToTurnOn) {
      this.turnOffSystem();
    } else if (this.currentHeatingCoolingState === systemToTurnOn && this.stopSystemTimer) {
      this.log(`RESUMING ${systemToTurnOn}`);
      clearTimeout(this.stopSystemTimer);
      this.stopSystemTimer = null;
    }
  }
  
  turnOffSystem() {
    const timeSinceSystemStarted = (new Date() - this.systemStartTime);
    const waitTime = Math.floor((this.minimumOnOffTime - timeSinceSystemStarted) / 1000);
    if (!this.stopSystemTimer) {
      this.log(`STOPPING ${this.currentlyRunning} in ${waitTime} second(s)`);
      this.stopSystemTimer = setTimeout(() => {
        this.log(`STOP ${this.currentlyRunning}`);
        rpio.write(HeatingCoolingStateToRelayPin[this.currentHeatingCoolingState], rpio.LOW);
        this.systemStartTime = null;
        this.stopSystemTimer = null;
        this.service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
      }, waitTime * 1000);
    } else {
      this.log(`INFO ${this.currentlyRunning} is in process of turning off in ${waitTime} second(s)`);
    }
  }

  updateSystem() {
    if (this.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.OFF
        && this.targetHeatingCoolingState !== Characteristic.TargetHeatingCoolingState.OFF) {
      if (this.shouldTurnOnHeating) {
        this.turnOnSystem(Characteristic.CurrentHeatingCoolingState.HEAT);
      } else if (this.shouldTurnOnCooling) {
        this.turnOnSystem(Characteristic.CurrentHeatingCoolingState.COOL);
      }
    } else if (this.currentHeatingCoolingState !== Characteristic.CurrentHeatingCoolingState.OFF
        && this.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.OFF) {
      this.turnOffSystem();
    } else if (this.currentHeatingCoolingState !== Characteristic.CurrentHeatingCoolingState.OFF
              && this.targetHeatingCoolingState !== Characteristic.TargetHeatingCoolingState.OFF) {
      if (this.shouldTurnOnHeating) {
        this.turnOnSystem(Characteristic.CurrentHeatingCoolingState.HEAT);
      } else if (this.shouldTurnOnCooling) {
        this.turnOnSystem(Characteristic.CurrentHeatingCoolingState.COOL);
      } else {
        this.turnOffSystem();
      }
    }
  }

  setupTemperatureCheckInterval() {
    setInterval(() => {
      dhtSensor.read(22, this.temperatureSensorPin, (err, temperature, humidity) => {
        if (!err) {
          this.currentTemperature = temperature;
          this.currentRelativeHumidity = humidity;
          this.service.setCharacteristic(Characteristic.CurrentTemperature, this.currentTemperature);
          this.service.setCharacteristic(Characteristic.CurrentRelativeHumidity, this.currentRelativeHumidity);
        } else {
          this.log('ERROR Getting temperature');
        }
      });
    }, this.temperatureCheckInterval);
  }

  getServices() {
    const informationService = new Service.AccessoryInformation();

    informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Encore Dev Labs')
      .setCharacteristic(Characteristic.Model, 'Pi Thermostat')
      .setCharacteristic(Characteristic.SerialNumber, 'Raspberry Pi 3');

    // Off, Heat, Cool
    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', callback => {
        this.log('CurrentHeatingCoolingState:', this.currentHeatingCoolingState);
        callback(null, this.currentHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        this.log('SET CurrentHeatingCoolingState from', this.currentHeatingCoolingState, 'to', value);
        this.currentHeatingCoolingState = value;
        callback(null);
      });

    // Off, Heat, Cool, Auto
    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', callback => {
        this.log('TargetHeatingCoolingState:', this.targetHeatingCoolingState);
        callback(null, this.targetHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        this.log('SET TargetHeatingCoolingState from', this.targetHeatingCoolingState, 'to', value);
        this.targetHeatingCoolingState = value;
        this.updateSystem();
        callback(null);
      });

    // Current Temperature
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: this.minTemp,
        maxValue: this.maxTemp,
        minStep: 1
      })
      .on('get', callback => {
        this.log('CurrentTemperature:', this.currentTemperature);
        callback(null, this.currentTemperature);
      })
      .on('set', (value, callback) => {
        this.updateSystem();
        callback(null);
      });

    // Target Temperature
    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.minTemp,
        maxValue: this.maxTemp,
        minStep: 1
      })
      .on('get', callback => {
        this.log('TargetTemperature:', this.targetTemperature);
        callback(null, this.targetTemperature);
      })
      .on('set', (value, callback) => {
        this.log('SET TargetTemperature from', this.targetTemperature, 'to', value);
        this.targetTemperature = value;
        this.updateSystem();
        callback(null);
      });

    // °C or °F for units
    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', callback => {
        this.log('TemperatureDisplayUnits:', this.temperatureDisplayUnits);
        callback(null, this.temperatureDisplayUnits);
      })
      .on('set', (value, callback) => {
        this.log('SET TemperatureDisplayUnits from', this.temperatureDisplayUnits, 'to', value);
        this.temperatureDisplayUnits = value;
        callback(null);
      });

    // Get Humidity
    this.service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', callback => {
        this.log('CurrentRelativeHumidity:', this.currentRelativeHumidity);
        callback(null, this.currentRelativeHumidity);
      });

    // Auto max temperature
    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .on('get', callback => {
        this.log('CoolingThresholdTemperature:', this.coolingThresholdTemperature);
        callback(null, this.coolingThresholdTemperature);
      })
      .on('set', (value, callback) => {
        this.log('SET CoolingThresholdTemperature from', this.coolingThresholdTemperature, 'to', value);
        this.coolingThresholdTemperature = value;
        callback(null);
      });

    // Auto min temperature
    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .on('get', callback => {
        this.log('HeatingThresholdTemperature:', this.heatingThresholdTemperature);
        callback(null, this.heatingThresholdTemperature);
      })
      .on('set', (value, callback) => {
        this.log('SET HeatingThresholdTemperature from', this.heatingThresholdTemperature, 'to', value);
        this.heatingThresholdTemperature = value;
        callback(null);
      });

    this.service
      .getCharacteristic(Characteristic.Name)
      .on('get', callback => {
        callback(null, this.name);
      });

    return [informationService, this.service];
  }
}

'use strict'
const bitwise = require('bitwise')

let Accessory, Service, Characteristic

class IndoorUnit {
  constructor(platform, serial, capabilityRegisters) {
    this.platform = platform
    Accessory = platform.Accessory
    Service = platform.Service
    Characteristic = platform.Characteristic

    this.serial = serial
    this.capabilityRegisters = capabilityRegisters
    // inputRegisters is big endian
    this.inputRegisters = undefined
    this.accessory = undefined

    const val = this.capabilityRegisters.readUInt16BE(0)
    this.fanMode = bitwise.integer.getBit(val, 0)
    this.coolingMode = bitwise.integer.getBit(val, 1)
    this.heatingMode = bitwise.integer.getBit(val, 2)
    this.autoMode = bitwise.integer.getBit(val, 3)
    this.dryMode = bitwise.integer.getBit(val, 4)
    this.fanDirection = bitwise.integer.getBit(val, 11)
    this.fanVolume = bitwise.integer.getBit(val, 15)
    this.coolinglowerLimit = this.capabilityRegisters.readInt8(2)
    this.coolingUpperLimit = this.capabilityRegisters.readInt8(3)
    this.heatinglowerLimit = this.capabilityRegisters.readInt8(4)
    this.heatingUpperLimit = this.capabilityRegisters.readInt8(5)
  }

  getType() {
    if (this.coolingMode && this.heatingMode)
      return 'Air_Conditioner'
    else
      return 'Heat_Reclaim_Ventilation'
  }

  changeInputRegisters(data) {
    const register1 = data.readUInt16BE(0)
    const onOff = bitwise.integer.getBit(register1, 0)
    if (this.accessory.category === Accessory.Categories.THERMOSTAT) {
      const register2 = data.readUInt16BE(2)
      const operationMode = register2 & 0x000f
      let state = Characteristic.CurrentHeatingCoolingState.OFF
      if (onOff) {
        if (operationMode === 1) {
          state = Characteristic.CurrentHeatingCoolingState.HEAT
        } else {
          state = Characteristic.CurrentHeatingCoolingState.COOL
        }
      }
      this.currentState.updateValue(state)
      this.targetState.updateValue(state)

      const currentValue = data.readInt16BE(8) / 10
      this.currentTemp.updateValue(currentValue)

      const targetValue = data.readInt16BE(4) / 10
      this.targetTemp.updateValue(targetValue)
    } else if (this.accessory.category === Accessory.Categories.FAN) {
      this.onState.updateValue(onOff)
    }
    this.inputRegisters = data
  }

  setAccessory(accessory) {
    this.accessory = accessory

    if (accessory.category === Accessory.Categories.THERMOSTAT) {
      const service = accessory.getService(Service.Thermostat) || accessory.addService(Service.Thermostat, accessory.displayName)
      service.getCharacteristic(Characteristic.TemperatureDisplayUnits).on('get', callback => {
        callback(null, Characteristic.TemperatureDisplayUnits.CELSIUS)
      })

      this.currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      this.targetState = service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      this.currentTemp = service.getCharacteristic(Characteristic.CurrentTemperature)
      this.targetTemp = service.getCharacteristic(Characteristic.TargetTemperature)

      this.currentState.on('get', callback => {
        console.log('get currentState')
        this.platform.sync().then(() => {
          callback(null, this.currentState.value)
        })
      })
      this.targetState.on('get', callback => {
        this.platform.sync().then(() => {
          callback(null, this.targetState.value)
        })
      })
      this.currentTemp.on('get', callback => {
        this.platform.sync().then(() => {
          callback(null, this.currentTemp.value)
        })
      })
      this.targetTemp.on('get', callback => {
        this.platform.sync().then(() => {
          callback(null, this.targetTemp.value)
        })
      })
      this.targetState.on('set', (value, callback) => {
        this.platform.sync().then(() => {
          if (value === Characteristic.TargetHeatingCoolingState.OFF)
            this.inputRegisters.writeUInt8(0, 1)
          else
            this.inputRegisters.writeUInt8(1, 1)
          this.platform.sendPresetSingleRegisterCommand(1, 42001 + this.serial * 3, this.inputRegisters.slice(0, 2)).then(() => {
            callback()
          })
        })
      })
      this.targetTemp.props.minValue = this.coolinglowerLimit
      this.targetTemp.props.maxValue = this.coolingUpperLimit
      this.targetTemp.on('set', (value, callback) => {
        this.platform.sync().then(() => {
          this.inputRegisters.writeInt16BE(value * 10, 4)
          this.platform.sendPresetSingleRegisterCommand(1, 42003 + this.serial * 3, this.inputRegisters.slice(4, 6)).then(() => {
            callback()
          })
        })
      })
    } else if (accessory.category === Accessory.Categories.FAN) {
      const service = accessory.getService(Service.Fan) || accessory.addService(Service.Fan, accessory.displayName)
      this.onState = service.getCharacteristic(Characteristic.On)
      this.onState.on('get', callback => {
        this.platform.sync().then(() => {
          callback(null, this.onState.value)
        })
      })
      this.onState.on('set', (value, callback) => {
        this.platform.sync().then(() => {
          if (value) {
            this.inputRegisters.writeUInt8(1, 1)
          } else {
            this.inputRegisters.writeUInt8(0, 1)
          }
          this.platform.sendPresetSingleRegisterCommand(1, 42001 + this.serial * 3, this.inputRegisters.slice(0, 2)).then(() => {
            callback()
          })
        })
      })
    }
  }
}

module.exports = IndoorUnit
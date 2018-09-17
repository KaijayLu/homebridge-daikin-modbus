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
    if (this.accessory.category === Accessory.Categories.THERMOSTAT) {

      const service = this.accessory.getService(Service.Thermostat)

      const register1 = data.readUInt16BE(0)
      const register2 = data.readUInt16BE(2)
      const onOff = bitwise.integer.getBit(register1, 0)
      const operationMode = register2 & 0x000f
      let state = Characteristic.CurrentHeatingCoolingState.OFF
      if (onOff) {
        if (operationMode === 1) {
          state = Characteristic.CurrentHeatingCoolingState.HEAT
        } else {
          state = Characteristic.CurrentHeatingCoolingState.COOL
        }
      }
      service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(state)
      service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(state)

      const currentValue = data.readInt16BE(8) / 10
      service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(currentValue)

      const targetValue = data.readInt16BE(4) / 10
      service.getCharacteristic(Characteristic.TargetTemperature).updateValue(targetValue)

      const displayUnits = Characteristic.TemperatureDisplayUnits.CELSIUS
      service.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(displayUnits)
    } else if (accessory.category === Accessory.Categories.FAN) {
      const service = this.accessory.getService(Service.Fan)
    }
    this.inputRegisters = data
  }

  setAccessory(accessory) {
    this.accessory = accessory

    if (accessory.category === Accessory.Categories.THERMOSTAT) {
      const service = accessory.getService(Service.Thermostat) || accessory.addService(Service.Thermostat, accessory.displayName)
      service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on('set', (value, callback) => {
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
      const targetTemperature = service.getCharacteristic(Characteristic.TargetTemperature)
      targetTemperature.props.minValue = this.coolinglowerLimit
      targetTemperature.props.maxValue = this.coolingUpperLimit
      targetTemperature
        .on('set', (value, callback) => {
          this.platform.sync().then(() => {
            this.inputRegisters.writeInt16BE(value * 10, 4)
            this.platform.sendPresetSingleRegisterCommand(1, 42003 + this.serial * 3, this.inputRegisters.slice(4, 6)).then(() => {
              callback()
            })
          })
        })
    } else if (accessory.category === Accessory.Categories.FAN) {
      const service = accessory.getService(Service.Fan) || accessory.addService(Service.Fan, accessory.displayName)
      service.getCharacteristic(Characteristic.On)
        .on('set', (value, callback) => {
          this.platform.sync().then(() => {
            if (value) {
              this.inputRegisters.writeUInt8(0, 1)
            } else {
              this.inputRegisters.writeUInt8(1, 1)
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
'use strict'
const crc = require('crc')
const SerialPort = require('serialport')
const bitwise = require('bitwise')
const IndoorUnit = require('./IndoorUnit')

let PlatformAccessory, Accessory, Service, Characteristic, UUIDGen

module.exports = function(homebridge) {
  PlatformAccessory = homebridge.platformAccessory
  Accessory = homebridge.hap.Accessory
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  UUIDGen = homebridge.hap.uuid

  homebridge.registerPlatform('homebridge-daikin-modbus', 'DaikinModbusPlatform', DaikinModbusPlatform, true)
}

function DaikinModbusPlatform (log, config, api) {
  this.PlatformAccessory = PlatformAccessory
  this.Accessory = Accessory
  this.Service = Service
  this.Characteristic = Characteristic
  this.UUIDGen = UUIDGen

  this.log = log
  this.config = config
  this.api = api
  this.accessories = {}
  this.commandPromises = []
  this.units = new Array(16)
  this.initialized = false

  if (config) {
    this.api.on('didFinishLaunching', () => {
      this.log('didFinishLaunching')
      this.initSerialPort()
      this.initSystem()

      setInterval(() => {
        if (this.initialized === false) {
          this.initSystem()
        }
      }, 5000)

      setInterval(() => {
        if (this.initialized === true) {
          this.sync()
        }
      }, 60 * 1000)
    })
  }
}

DaikinModbusPlatform.prototype.configureAccessory = function(accessory) {
  this.accessories[accessory.UUID] = accessory
}

DaikinModbusPlatform.prototype.initSerialPort = function () {
  const port = new SerialPort(this.config.path, {
    parity: 'even'
  })

  port.on('error', (err) => {
    this.log(err.message)
  })

  // max length of data is 32 bytes
  const dataArray = []
  port.on('data', (data) => {
    dataArray.push(data)
    if (data.length < 32) {
      this.checkMessage(Buffer.concat(dataArray))
      dataArray.length = 0
    }
  })

  port.on('open', () => {
    this.log('port opened')
  })
  this.port = port
}

DaikinModbusPlatform.prototype.initSystem = function () {
  // get adaptor status
  this.sendReadInputRegisterCommand(1, 30001, 1).then(res => {
    const val = res.readUInt16BE(3)
    if (bitwise.integer.getBit(val, 0) === 1) {
      // get indoor unit connection status
      return this.sendReadInputRegisterCommand(1, 30002, 1)
    } else {
      return Promise.reject(new Error('Adaptor is not ready'))
    }
  }).then(res => {
    const connectionStatus = res.readUInt16BE(3)
    // get indoor unit capability information
    // read 8 units at a time
    const times = ((connectionStatus & 0xff00) > 0) ? 2 : 1
    const numberOfRegister = 3 * 8
    const numberOfBytes = numberOfRegister * 2
    const data = Buffer.alloc(numberOfBytes * times)
    let p = Promise.resolve()
    for (let i = 0; i < times; i++) {
      p = p.then(() => {
        return this.sendReadInputRegisterCommand(1, 31001 + i * numberOfRegister, numberOfRegister)
      }).then(res => {
        res.copy(data, i * numberOfBytes, 3, 3 + numberOfBytes)
      })
    }
    return p.then(() => {
      for (let i = 0; i < 16; i++) {
        if (bitwise.integer.getBit(connectionStatus, i) === 1) {
          const start = i * 3 * 2
          const capabilityRegisters = data.slice(start, start + 6)
          const unit = new IndoorUnit(this, i, capabilityRegisters)
          const uuid = UUIDGen.generate('DAIKIN' + i)
          let accessory = this.accessories[uuid]
          if (!accessory) {
            if (unit.getType() === 'Air_Conditioner') {
              const accessoryName = 'DAIKIN Air Conditioner ' + i
              accessory = new PlatformAccessory(accessoryName, uuid, Accessory.Categories.THERMOSTAT)
            } else {
              const accessoryName = 'DAIKIN Heat reclaim ventilation'
              accessory = new PlatformAccessory(accessoryName, uuid, Accessory.Categories.FAN)
            }
            this.registerPlatformAccessories([accessory])
          }
          unit.setAccessory(accessory)
          this.units[i] = unit
        } else {
          this.units[i] = undefined
        }
      }
    })
  }).then(() => {
    return this.refreshAllRegisters()
  }).catch(err => {
    this.log.warn(err)
  }).then(() => {
    this.initialized = true
    this.log.info('System initialization finished.')
  })
}

DaikinModbusPlatform.prototype.sendCommand = function (data) {
  if (!this._promise) {
    this._promise = Promise.resolve()
  }
  this._promise = this._promise.then(() => {
    return new Promise((resolve, reject) => {
      this.commandPromises.push({
        resolve: res => {
          this.commandPromises.shift()
          resolve(res)
        },
        reject: err => {
          this.commandPromises.shift()
          reject(err)
        }
      })
      // wait Silent Interval Time + 20ms
      setTimeout(() => {
        this.port.write(data)
        this.log.debug('[Sent] ' + data.toString('hex'))
      }, 5 + 20)
    })
  }).catch(err => {
    this.log.warn(err)
  })
  return this._promise
}

DaikinModbusPlatform.prototype.sendReadInputRegisterCommand = function (slaveAddress, startRegisterNumber, count) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(8)
    buf.writeUInt8(slaveAddress, 0)
    buf.writeUInt8(0x4, 1)
    buf.writeUInt16BE(startRegisterNumber - 30001, 2)
    buf.writeUInt16BE(count, 4)
    buf.writeUInt16LE(crc.crc16modbus(buf.slice(0, 6)), 6)
    this.sendCommand(buf).then(res => {
      resolve(res)
    }).catch((err) => {
      reject(err)
    })
  })
}

DaikinModbusPlatform.prototype.sendPresetSingleRegisterCommand = function (slaveAddress, registerNumber, valueBuffer) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(8)
    buf.writeUInt8(slaveAddress, 0)
    buf.writeUInt8(0x6, 1)
    buf.writeUInt16BE(registerNumber - 40001, 2)
    valueBuffer.copy(buf, 4)
    buf.writeUInt16LE(crc.crc16modbus(buf.slice(0, 6)), 6)
    this.sendCommand(buf).then(res => {
      resolve(res)
    }).catch((err) => {
      reject(err)
    })
  })
}

DaikinModbusPlatform.prototype.sendPresetMultipleRegisterCommand = function (slaveAddress, registerNumber, valueBuffer) {
  return new Promise((resolve, reject) => {
    const count = valueBuffer.length / 2
    const buf = Buffer.alloc(9 + count * 2)
    // slave address
    buf.writeUInt8(slaveAddress, 0)
    // function code
    buf.writeUInt8(0x10, 1)
    // start address
    buf.writeUInt16BE(registerNumber - 40001, 2)
    // number of registers
    buf.writeUInt16BE(count, 4)
    // data size(bytes)
    buf.writeUInt8(count * 2, 6)
    // data
    valueBuffer.copy(buf, 7)
    buf.writeUInt16LE(crc.crc16modbus(buf.slice(0, 7 + count * 2)), 7 + count * 2)
    this.sendCommand(buf).then(res => {
      resolve(res)
    }).catch((err) => {
      reject(err)
    })
  })
}

DaikinModbusPlatform.prototype.sync = function () {
  if (!this._getPromise) {
    this._getPromise = Promise.resolve()
  }
  this._getPromise = this._getPromise.then(() => {
    return new Promise((resolve, reject) => {
      if (Date.now() - this._lastTime < 5000) {
        resolve()
      } else {
        this.refreshAllRegisters().then(() => {
          this.log.warn('----------------------------- refreshAllRegisters() finished')
          this._lastTime = Date.now()
          resolve()
        }).catch(err => {
          this.log.warn('sync error: ' + err)
          this._lastTime = Date.now()
          reject(err)
        })
      }
    })
  }).catch(err => {
    this.log.warn(err)
  })
  return this._getPromise
}

DaikinModbusPlatform.prototype.refreshAllRegisters = function () {
  return new Promise((resolve, reject) => {
    this.log.warn('refreshAllRegisters() started')
    let p = Promise.resolve()
    // it can read 32 registers at a time
    const numberOfInputRegister = 32
    const data = Buffer.alloc(16 * 6 * 2)
    for (let i = 0; i < 3; i++) {
      p = p.then(() => {
        // get indoor unit status
        return this.sendReadInputRegisterCommand(1, 32001 + i * numberOfInputRegister, numberOfInputRegister)
      }).then(res => {
        res.copy(data, i * numberOfInputRegister * 2, 3, 3 + numberOfInputRegister * 2)
      })
    }
    p.then(() => {
      this.units.forEach((unit, index) => {
        if (unit) {
          const start = index * 6 * 2
          unit.changeInputRegisters(data.slice(start, start + 6 * 2))
        }
      })
    }).then(() => {
      // it can write 30 registers at a time
      let p2 = Promise.resolve()
      const segments = []
      const temp = []
      let start
      const collect = () => {
        segments.push({
          'start': start,
          'data': Buffer.concat(temp)
        })
        temp.length = 0;
      }
      for (let i = 0; i < 16; i++) {
        const unit = this.units[i]
        if (unit) {
          if (temp.length === 0)
            start = 42001 + i * 3
          if (unit.getType() === 'Heat_Reclaim_Ventilation') {
            // only write first registerm, 2nd & 3nd register will cause error
            temp.push(unit.inputRegisters.slice(0, 2))
            collect()
          } else {
            temp.push(unit.inputRegisters.slice(0, 6))
            if (temp.length === 10) // fill with 30 registers
              collect()
          }
        } else  if (temp.length > 0) {
          // it's not continuous
          collect()
        }
      }
      segments.forEach(segment => {
        p2 = p2.then(() => {
          return this.sendPresetMultipleRegisterCommand(1, segment.start, segment.data)
        })
      })
      return p2
    }).then(() => {
      resolve()
    }).catch(err => {
      reject(err)
    })
  })
}

DaikinModbusPlatform.prototype.checkMessage = function (data) {
  this.log.debug('[Received] ' + data.toString('hex'))

  const address = data.readUInt8(0)
  const funCode = data.readUInt8(1)

  const p = this.commandPromises[0]

  // Exception response
  if (funCode === 0x84 || funCode === 0x86 || funCode === 0x90) {
    const err = new Error('Exception response')
    p.reject(err)
    return
  }

  const errCheckAt = (funCode === 4) ? 3 + data.readUInt8(2) : 6
  const errCheck = data.readUInt16LE(errCheckAt)

  if (errCheck === crc.crc16modbus(data.slice(0, errCheckAt))) {
    p.resolve(data)
  } else {
    const err = new Error('CRC16 check error')
    p.reject(err)
  }
}

DaikinModbusPlatform.prototype.registerPlatformAccessories = function(accessories) {
  this.api.registerPlatformAccessories('homebridge-daikin-modbus', 'DaikinModbusPlatform', accessories)
  accessories.forEach((accessory, index, arr) => {
    this.log.info("create accessory - UUID: " + accessory.UUID)
    this.accessories[accessory.UUID] = accessory
  })
}

DaikinModbusPlatform.prototype.unregisterPlatformAccessories = function(accessories) {
  this.api.unregisterPlatformAccessories('homebridge-daikin-modbus', 'DaikinModbusPlatform', accessories)
  accessories.forEach((accessory, index, arr) => {
    this.log.info("delete accessory - UUID: " + accessory.UUID)
    delete this.accessories[accessory.UUID]
  })
}
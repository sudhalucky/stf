var oboe = require('oboe')
var _ = require('lodash')
var EventEmitter = require('eventemitter3')

var IOS_ORIENTATION_MAP = {
  'PORTRAIT': 0,
  'LANDSCAPE': 90, 'UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT': 270,
  'UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN': 180
}


module.exports = function DeviceServiceFactory($http, socket, EnhanceDeviceService) {
  var deviceService = {}
  function fetchIOSDevice(device) {
    return $http.get('http://' + device.host + ':8100/device', {timeout: 5 * 1000})
  }

  function fetchIOSOrientation(device) {
    var host = device.host
    return $http.get('http://' + host + ':8100/status').then(ret => {
      return $http.get(`http://${host}:8100/session/${ret.data.sessionId}/orientation`)
    })
  }

  function Tracker($scope, options) {
    var devices = []
    var devicesBySerial = Object.create(null)
    var scopedSocket = socket.scoped($scope)
    var digestTimer, lastDigest
    var iosInterval = null

    $scope.$on('$destroy', function() {
      clearTimeout(digestTimer)
      clearInterval(iosInterval)
    })

    function digest() {
      // Not great. Consider something else
      if (!$scope.$$phase) {
        $scope.$digest()
      }

      lastDigest = Date.now()
      digestTimer = null
    }

    function notify(event) {
      if (!options.digest) {
        return
      }

      if (event.important) {
        // Handle important updates immediately.
        //digest()
        window.requestAnimationFrame(digest)
      }
      else {
        if (!digestTimer) {
          var delta = Date.now() - lastDigest
          if (delta > 1000) {
            // It's been a while since the last update, so let's just update
            // right now even though it's low priority.
            digest()
          }
          else {
            // It hasn't been long since the last update. Let's wait for a
            // while so that the UI doesn't get stressed out.
            digestTimer = setTimeout(digest, delta)
          }
        }
      }
    }

    function sync(data) {
      // usable IF device is physically present AND device is online AND
      // preparations are ready AND the device has no owner or we are the
      // owner
      data.usable = data.present && data.status === 3 && data.ready &&
        (!data.owner || data.using)

      // Make sure we don't mistakenly think we still have the device
      if (!data.usable || !data.owner) {
        data.using = false
      }

      EnhanceDeviceService.enhance(data)
    }

    function get(data) {
      return devices[devicesBySerial[data.serial]]
    }

    var insert = function insert(data) {
      devicesBySerial[data.serial] = devices.push(data) - 1
      sync(data)
      this.emit('add', data)
    }.bind(this)

    var modify = function modify(data, newData) {
      _.merge(data, newData, function(a, b) {
        // New Arrays overwrite old Arrays
        if (_.isArray(b)) {
          return b
        }
      })
      sync(data)
      this.emit('change', data)
    }.bind(this)

    var remove = function remove(data) {
      var index = devicesBySerial[data.serial]
      if (index >= 0) {
        devices.splice(index, 1)
        delete devicesBySerial[data.serial]
        this.emit('remove', data)
      }
    }.bind(this)

    function fetch(data) {
      deviceService.load(data.serial)
        .then(function(device) {
          return changeListener({
            important: true
            , data: device
          })
        })
        .catch(function() { })
    }

    function addListener(event) {
      var device = get(event.data)
      if (device) {
        if (device.platform === 'iOS') {
          fetchIOSDevice(device)
            .then(function(response) {
              device.ready = true
              device.present = true
              device.usable = true
              device.version = response.data.version
              device.product = response.data.product
              event.data._name = response.data.provider.name
              event.data.ready = true
              event.data.present = true
              event.data.usable = true
              event.data.version = response.data.version
              modify(device, event.data)
              notify(event)
            }).catch(() => {
              device.ready = false
              device.present = false
              device.usable = false
              event.data.ready = false
              event.data.present = false
              event.data.usable = false
              modify(device, event.data)
              notify(event)
            })
        } else {
          modify(device, event.data)
          notify(event)
        }
      }
      else {
        if (options.filter(event.data)) {
          if (event.data.platform === 'iOS') {
            fetchIOSDevice(event.data)
              .then(function(response) {
                event.data.ready = true
                event.data.present = true
                event.data.usable = true
                event.data.version = response.data.version
                event.data.product = response.data.product
                event.data._name = response.data.provider.name
                setTimeout(() => {
                  insert(event.data)
                  notify(event)
                }, 100)
              }).catch(() => {
              event.data.ready = false
              event.data.present = false
              event.data.usable = false
              setTimeout(() => {
                insert(event.data)
                notify(event)
              }, 100)
            })
          }
          else {
            insert(event.data)
            notify(event)
          }
        }
      }
    }

    function changeListener(event) {
      var device = get(event.data)
      if (device) {
        modify(device, event.data)
        if (!options.filter(device)) {
          remove(device)
        }
        notify(event)
      }
      else {
        if (options.filter(event.data)) {
          insert(event.data)
          // We've only got partial data
          fetch(event.data)
          notify(event)
        }
      }
    }

    scopedSocket.on('device.add', addListener)
    scopedSocket.on('device.remove', changeListener)
    scopedSocket.on('device.change', changeListener)

    this.add = function(device) {
      addListener({
        important: true
        , data: device
      })
    }

    this.devices = devices

    /**
     * mock web socket notify ios device rotation
     */
    iosInterval = setInterval(() => {
      this.devices.forEach(device => {
        if (device.platform !== 'iOS') { // we don't care android device
          return
        }

        fetchIOSOrientation(device).then(r => {


          var rotation = 0
          if (IOS_ORIENTATION_MAP.hasOwnProperty(r.data.value)) {
            rotation = IOS_ORIENTATION_MAP[r.data.value]
          }
          if (device.display && device.display.rotation === rotation) { // same, ignore
            return
          }
          device.display = {
            rotation
          }
          changeListener({data: device})
        })
      })
    }, 2*1000)
  }

  Tracker.prototype = new EventEmitter()

  deviceService.trackAll = function($scope) {
    var tracker = new Tracker($scope, {
      filter: function() {
        return true
      }
      , digest: false
    })

    oboe('/api/v1/devices')
      .node('devices[*]', function(device) {
        // if it is a iOS device
        if (device.platform !== 'Android') {
          device.platform = 'iOS'
          $http.get('http://' + device.host + ':8100/status')
            .then(function(res) {
              device.ready = true
              device.present = true
              device.usable = true
              device.display = {
                width: res.data.value.screen.width,
                height: res.data.value.screen.height
              }
              tracker.add(device)
            }).catch(err => {
              device.ready = false
              device.present = false
              device.usable = false
              tracker.add(device)
            })
        }
        else {
          tracker.add(device)
        }
      })

    return tracker
  }

  deviceService.trackGroup = function($scope) {
    var tracker = new Tracker($scope, {
      filter: function(device) {
        return device.using
      }
      , digest: true
    })

    oboe('/api/v1/user/devices')
      .node('devices[*]', function(device) {
        tracker.add(device)
      })

    return tracker
  }

  deviceService.load = function(serial) {
    return $http.get('/api/v1/devices/' + serial)
      .then(function(response) {
        var device = response.data.device
        if (device.platform !== 'Android') {
          device.platform = 'iOS'
          // return Promise.resolve(device)
          return new Promise((resolve, reject) => {
            device.platform = 'iOS'
            fetchIOSDevice(device)
              .then(function(res) {
                device.ready = true
                device.present = true
                device.usable = true
                device.version = res.data.version
                device.product = res.data.product
                device._name = res.data.provider.name
                device.display = {

                }
                resolve(device)
              }).catch(err => {
                device.ready = false
                device.present = false
                device.usable = false
              })
          })
        } else {
          return response.data.device
        }
      })
  }

  deviceService.get = function(serial, $scope) {
    var tracker = new Tracker($scope, {
      filter: function(device) {
        return device.serial === serial
      }
      , digest: true
    })

    return deviceService.load(serial)
      .then(function(device) {
        tracker.add(device)
        return device
      })
  }

  deviceService.updateNote = function(serial, note) {
    socket.emit('device.note', {
      serial: serial,
      note: note
    })
  }

  return deviceService
}

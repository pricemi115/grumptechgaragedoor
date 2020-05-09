/* ==========================================================================
   File:        doorCntrl.js
   Class:       Door Controller
   Description: Provides status and control of a garage door via
                Raspberry PI GPIO.
   Copyright:   May 2019
   ========================================================================== */
'use strict';

// External dependencies and imports.
const _debug  = require('debug')('doorCntrl');
const _gpio   = require('rpi-gpio');
import { EventEmitter } from 'events';
const _gpiop  = _gpio.promise;

// Internal dependencies
import * as modSensorCommon from './sensorBase.js';
import _proxSensor          from './proxSensor.js';
import _sonarSensor         from './sonarSensor.js';

/* Enumeration for Door States */
const DOOR_STATE = {
  UNKNOWN : 'UNKNOWN',
  OPEN    : 'OPEN',
  OPENING : 'OPENING',
  CLOSING : 'CLOSING',
  CLOSED  : 'CLOSED',
};

/* Time to debounce door control switch state changes */
const _DOOR_CNTRL_SWITCH_DEBOUNCE   =   500/*ms*/;
/* Time for toggling the control relay to open/close a door. */
const _DOOR_CTRL_REQ_TIME           =   100/*ms*/;
/* Expected time for door activation to complete */
const _DOOR_ACTIVATION_TIMEOUT      = 30000/*ms*/;
/* Total time for the door identification process */
const _DOOR_TOTAL_IDENTIFICATION_TIMEOUT    = 5000/*ms*/;
/* Time for toggling the door state LED when identifying the door */
const _DOOR_IDENTIFICATION_TOGGLE_TIMEOUT   =  100/*ms*/;

/* ========================================================================
   Description: Helper function to perform a delay

   Parameters:  timeout:  Delay in milliseconds.

   Return:      Promise.

   Remarks:     Assumed to be executed via async/await.
   ======================================================================== */
const _delay = timeout => new Promise( resolveDelay => { setTimeout(resolveDelay, timeout); });

/* DoorController represents a garage door control system configured, monitored,
   and controlled by a RaspberryPi.

   @event 'state_change' => function(oldState, newState, context) {}
          Emitted when the door changes its open/closed states.
          Context will be a reference to the instance of the object raising the event.
*/
class DoorController extends EventEmitter {
  /* ========================================================================
     Description: Constructor for an instance of a garage door controller.

     Parameters:  configuration:            Object with the following fields.
                  { name:                   Name of the door.
                    state_indicator:        GPIO Input Channel for a door status switch.
                                            ** Assumed to be in the GPIO Mode of the Door System Controller.
                    state_switch:           GPIO Output Channel for a door status indicator LED.
                                            ** Assumed to be in the GPIO Mode of the Door System Controller.
                    control_request:        GPIO Output Channel for a door request to control a relay.
                                            ** Assumed to be in the GPIO Mode of the Door System Controller.
                    control_reqest_switch:  GPIO Input Channel for a door open/close request switch.
                                            ** Assumed to be in the GPIO Mode of the Door System Controller.
                    detect_sensors:         Configuration node for the detection sensor(s).
                  }
     Return:      N/A
     ======================================================================== */
  constructor(configuration) {

    // Initialize the base class.
    super();

    _debug(`Constructing door`);

    // Validate the supplied configuration.
    const configValid = ( (configuration.hasOwnProperty('name')                  && (typeof(configuration.name)                  === 'string'))                                               &&
                          (configuration.hasOwnProperty('state_indicator')       && (typeof(configuration.state_indicator)       === 'number'))                                               &&
                          (configuration.hasOwnProperty('control_request')       && (typeof(configuration.control_request)       === 'number'))                                               &&
                          (configuration.hasOwnProperty('manual_control_reqest') && (typeof(configuration.manual_control_reqest) === 'number'))                                               &&
                          // soft_locked is an optional setting.
                          ((configuration.hasOwnProperty('soft_locked')           && (typeof(configuration.soft_locked)           === 'boolean')) ||
                           (!configuration.hasOwnProperty('soft_locked')))                                                                                                                    &&
                          (configuration.hasOwnProperty('detect_sensors')        && (typeof(configuration.detect_sensors)        === 'object') && (configuration.detect_sensors.length >= 2)) &&
                          (this._validateDetectionSensorConfig(configuration.detect_sensors))                                                                                                   );
    if (!configValid) {
      _debug(`DoorController invalid configuration. configuration:${JSON.stringify(configuration)}`);
      throw new Error(`DoorController invalid configuration`);
    }

    /* Instance Name */
    this._name = configuration.name;

    /* GPIO Channel Assignments */
    this._gpioChanStateIndicator  = configuration.state_indicator;
    this._gpioChanCtrlRequest     = configuration.control_request;
    this._gpioManualCtrlRequest   = configuration.manual_control_reqest;

    // Create the open/closed sensors.
    this._openSensor              = this._createDetectionSensor(configuration.detect_sensors, 'OPEN');
    this._closedSensor            = this._createDetectionSensor(configuration.detect_sensors, 'CLOSE');

    /* Current Door Open/Close Staus */
    this._currentDoorState          = DOOR_STATE.UNKNOWN;
    /* Target Door Open/Close Staus */
    this._targetDoorState           = DOOR_STATE.UNKNOWN;
    /* Soft-Lock State - Defaults to locked if not specified */
    this._doorLocked                = (configuration.hasOwnProperty('soft_locked') ? configuration.soft_locked : true );
    /* Door Control Switch Debouce Timer Id */
    this._debounceTimerIdDoorCntrl  = undefined;
    /* Door Activation Watchdog Timer Id */
    this._doorActivationWatchdogId  = undefined;
    /* Flag indicating if this door has been started/initialized */
    this._initialized               = false;
    /* Create a function pointer for state change notifications. */
    this._myStateChangeCB           = this._stateChange.bind(this);
    /* Create a function pointer for the sensor result changed notification. */
    this._mySensorResultChangedCB   = this._sensorResultChanged.bind(this);

    _debug(`New Door: name=${this.Name}`);
  }

  /* ========================================================================
     Description: Destructor for an instance of a garage door controller.

     Parameters:  None

     Return:      None

     Remarks:     DO NOT reset the underlying GPIO peripheral. That should only
                  be handled by the door controller system. Simply make this
                  object inert and set the outputs back to default.
     ======================================================================== */
   async Terminate() {

    _debug(`Terminating Door: ${this.Name}`);

    // Unregister for change notifications
    _gpio.off( 'change', this._myStateChangeCB );

    // Unregister for the sensor events.
    this._openSensor.removeListener(   'result_changed',   this._mySensorResultChangedCB);
    this._closedSensor.removeListener( 'result_changed',   this._mySensorResultChangedCB);

    // Kill the detection sensors.
    this._openSensor.Terminate();
    this._closedSensor.Terminate();

    // Kill off any timers that may be pending
    if (this._debounceTimerIdDoorCntrl) {
      clearTimeout(this._debounceTimerIdDoorCntrl );
    }
    await Promise.all([/* The Door State Indicator is Active Low. */
                 _gpiop.write(this._gpioChanStateIndicator, false),
                 // The Door Control request is Active High.
                 _gpiop.write(this._gpioChanCtrlRequest, true)])
    .then (() => {
      /* Do Nothing */
    })
    .catch(() => {
      /* Do Nothing */
    })
    .finally(() => {
      this._initialized = false;
    });
  }

  /* ========================================================================
     Description: Start/Initialize the door.

     Parameters:  None

     Return:      Flag indicating if the door has been initialized.
     ======================================================================== */
  async Start() {

    _debug(`Starting Door: ${this.Name}`);

    // Clear the initialized flag, in case we are re-starting
    this._initialized        = false;

    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the door state indicator channel */
                       _gpiop.setup(this._gpioChanStateIndicator, _gpio.DIR_LOW),
                       /* Configure the door control channel and initialize to HIGH */
                       _gpiop.setup(this._gpioChanCtrlRequest,    _gpio.DIR_HIGH),
                       /* Configure the door request button input channel to detect release events */
                       _gpiop.setup(this._gpioManualCtrlRequest,  _gpio.DIR_IN,  _gpio.EDGE_RISING),
                      ])
    .then(async (setupResults) => {
      // Register for the detection sensor events.
      this._openSensor.on(   'result_changed',   this._mySensorResultChangedCB);
      this._closedSensor.on( 'result_changed',   this._mySensorResultChangedCB);

      // Now start the detection sensors.
      await this._openSensor.Start();
      await this._closedSensor.Start();
    })
    .then(async () => {
      // Get the current door state and update the indicator.
      this._currentDoorState = this._determineDoorState();
      _debug(`Door ${this.Name} is: ${this.DoorState}`);
      // Illuminate the Indicator LED if the Door is open.
      await _gpiop.write(this._gpioChanStateIndicator, this.DoorOpen);
      // Register for state change events for all input channels.
      _gpio.on( 'change', this._myStateChangeCB );

      // Indicate that the door is now initialized and ready to operate.
      this._initialized = true;
    })
    .catch((err) => {
      _debug(`Init Error(Door:${this.Name}): ${err.toString()}`);
    });

    return this._initialized;
  }

  /* ========================================================================
     Description: Read-Only Property for Door Open

     Parameters:  None

     Return:      true if the door is open. false otherwise.
     ======================================================================== */
  get DoorOpen() {
    return ( (DOOR_STATE.OPEN === this.DoorState) ? true : false );
  }

  /* ========================================================================
     Description: Read-Only Property for Door Closed

     Parameters:  None

     Return:      true if the door is closed. false otherwise.
     ======================================================================= */
  get DoorClosed() {
    return ( (DOOR_STATE.CLOSED === this.DoorState) ? true : false );
  }

  /* ========================================================================
     Description: Read-Only Property for Door State

     Parameters:  None

     Return:      Door State
     ======================================================================= */
  get DoorState() {
    return this._currentDoorState;
  }

  /* ========================================================================
     Description: Property for Door State

     Parameters:  None

     Return:      true if the door is locked.
     ======================================================================= */
  get DoorLocked() {
    return this._doorLocked;
  }

  /* ========================================================================
     Description: Property for Door State

     Parameters:  locked: Flag specifying if the door is locked or unlocked.

     Return:      None
     ======================================================================= */
  set DoorLocked(locked) {
    if (typeof(locked) === 'boolean') {
      this._doorLocked = locked;
    }
  }

  /* ========================================================================
     Description: Identify the door

     Parameters:  None

     Return:      Promise function. resolves true if initialized. false otherwise.

     Remarks:     Identify by flashing the door state LED. This function runs asynchronously.
     ======================================================================== */
  IdentifyDoor() {
    return new Promise(async resolve => {
      if (this.Initialized) {
        // Total number of LED toggle cycles needed for identification.
        const IDENTIFICATION_TOGGLE_CYCLES = _DOOR_TOTAL_IDENTIFICATION_TIMEOUT / _DOOR_IDENTIFICATION_TOGGLE_TIMEOUT;

        for (let count=0; count < IDENTIFICATION_TOGGLE_CYCLES; count++) {
          // Get the current LED State.
          const ledState = await _gpiop.read(this._gpioChanStateIndicator);
          // Update the Door Status LED for idenfification
          await _gpiop.write(this._gpioChanStateIndicator, !ledState);
          await _delay(_DOOR_IDENTIFICATION_TOGGLE_TIMEOUT);
        }

        // When done, ensure that the LED is restored to normal operation.
        this._updateDoorState(this.DoorState);
      }

      resolve(this.Initialized);
    });
  }

  /* ========================================================================
     Description: Activate the door (public accessor)

     Parameters:  None

     Return:      None
     ======================================================================== */
  ActivateDoor() {

    // Invoke door activation, indicating that the door needs to be unlocked.
    this._doActivateDoor(false);

  }

  /* ========================================================================
     Description: Read-Only Property for the name of this Door

     Parameters:  None

     Return:      Name of this object
     ======================================================================== */
  get Name() {
    return this._name;
  }

  /* ========================================================================
     Description: Read-Only Property for the initialized state of this Door

     Parameters:  None

     Return:      Initialized flag of this object
     ======================================================================== */
  get Initialized() {
    return this._initialized;
  }

  /* ========================================================================
     Description: Activate the door (public accessor)

     Parameters:  overrideLock: Flag indicating if the door activation should
                                override the lock.

     Return:      None
     ======================================================================== */
   _doActivateDoor(overrideLock) {
    // The door activates with an active low signal.
    const ACTIVATE_RELAY = false;

    // Is the object initialized ?
    if (this.Initialized &&
        ((!this.DoorLocked) || overrideLock))
    {
      _debug(`Activating Door: ${this.Name}`);

      /* Clear the activation watchdog */
      if (this._doorActivationWatchdogId != undefined) {
        clearTimeout(this._doorActivationWatchdogId );
      }

      // Activate the relay.
      _gpiop.write(this._gpioChanCtrlRequest, ACTIVATE_RELAY)
      .then(() => {
        // Once active, deactivate the relay after the appropriate delay.
        return setTimeout(_gpiop.write, _DOOR_CTRL_REQ_TIME, this._gpioChanCtrlRequest, !ACTIVATE_RELAY);
      })
      .catch((error) => {
        _debug(`(${this.Name}) Door Request Error: ${error.toString()}`);
      });

      // Once activated, set a watchdog in case the door does not respond.
      this._doorActivationWatchdogId = setTimeout( ((oldDoorState) => { this._updateDoorState(oldDoorState); }), _DOOR_ACTIVATION_TIMEOUT, this.DoorState );
    }
    else {
      _debug(`Door ${this.Name}: Cannot activate door. Not initialized or is locked. Initialized:${this.Initialized} Locked:${this.DoorLocked}`);
    }
  }

  /* ========================================================================
     Description: Event handler for State Change events on GPIO Inputs

     Parameters:  channel: GPIO Channel for the event.
                  value:   Value of the GPIO Input

     Return:      None
     ======================================================================== */
  _stateChange(channel, value) {
    switch (channel) {
      case (this._gpioManualCtrlRequest) :
      {
        /* The Control Request switch was configured for rising edge detection.
           Therefore, we can assume we can activate the door on any state change notification */
        if (this._debounceTimerIdDoorCntrl != undefined) {
          clearTimeout(this._debounceTimerIdDoorCntrl );
        }

        // Schedule a new debounce timout and cache the timer id
        this._debounceTimerIdDoorCntrl = setTimeout( (() => { this._doActivateDoor(true); }), _DOOR_CNTRL_SWITCH_DEBOUNCE );
      }
      break;

      default:
      {
        _debug(`Door (${this.Name}) Unhandled State Change. Chan:${channel} Val:${value}`);
      }
      break;
    }
  }

  /* ========================================================================
     Description: Event handler for Sensor Result Changed events

     Parameters:  oldResult: Prior sensor result.
                  newResult: Current sensor result.
                  context:   Reference to the sensor object raising the event.

     Return:      None
     ======================================================================== */
  _sensorResultChanged(oldResult, newResult, context) {
    // Compute the new door state
    const newDoorState = this._determineDoorState();

    _debug(`Door (${this.Name}): Sensor ${context.Identifier} result changed. Old:${oldResult} New:${newResult} OldDoorState:${this.DoorState} NewDoorState:${newDoorState}`);

    // Update the Door State.
    this._updateDoorState(newDoorState);
  }

  /* ========================================================================
     Description: Event handler for Detection Sensor Result Changed events

     Parameters:  None

     Return:      Updated door state.
       ======================================================================== */
  _determineDoorState() {
    let doorState = DOOR_STATE.UNKNOWN;

    // Regardless of which sensor just changed results, get the current result for both the open and closed sensor.
    const openResult    = this._openSensor.Result;
    const closedResult  = this._closedSensor.Result;

    _debug(`Door (${this.Name}): _determineDoorState openResult=${openResult} closedResult=${closedResult}`);

    // Based on the last known door state and the current sensor results,
    // determine the new current door state.
    if ((openResult   === modSensorCommon.SENSOR_RESULT.UNKNOWN) &&
        (closedResult === modSensorCommon.SENSOR_RESULT.UNKNOWN)) {
      // Door State is unknown.
      doorState = DOOR_STATE.UNKNOWN;
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.UNKNOWN) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.UNDETECTED)) {
      // Not conclusive, but assume the door is open.
      doorState = DOOR_STATE.OPEN;
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.UNKNOWN) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.DETECTED)) {
      // Door is closed.
      doorState = DOOR_STATE.CLOSED;
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.UNDETECTED) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.UNKNOWN)) {
      // Not conclusive, but assume the door is closed.
      doorState = DOOR_STATE.CLOSED;
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.UNDETECTED) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.UNDETECTED)) {
      // Both sensors indicating an undetected result.
      // Door state depends on the last known door state.
      switch (this.DoorState) {
        case DOOR_STATE.OPEN:
        {
          // Door was last known to be open.
          // Door is now closing.
          doorState = DOOR_STATE.CLOSING;
        }
        break;

        case DOOR_STATE.CLOSED:
        {
          // Door was last known to be closed.
          // Door is now opening.
          doorState = DOOR_STATE.OPENING;
        }
        break;

        case DOOR_STATE.UNKNOWN:
        {
          // Door was last known to be unknown.
          // Door is now unknown.
          doorState = DOOR_STATE.UNKNOWN;
        }
        break;

        case DOOR_STATE.OPENING:
        // Break intentionally missing.
        case DOOR_STATE.CLOSING:
        // Break intentionally missing
        default:
        {
          // No-Op. Leave the door state as-is.
        }
        break;
      }
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.UNDETECTED) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.DETECTED)) {
      // Door is closed.
      doorState = DOOR_STATE.CLOSED;
    }
    if ((openResult   === modSensorCommon.SENSOR_RESULT.DETECTED) &&
        (closedResult === modSensorCommon.SENSOR_RESULT.UNKNOWN)) {
      // Door State is open.
      doorState = DOOR_STATE.OPEN;
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.DETECTED) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.UNDETECTED)) {
      // Door is open
      doorState = DOOR_STATE.OPEN;
    }
    else if ((openResult   === modSensorCommon.SENSOR_RESULT.DETECTED) &&
             (closedResult === modSensorCommon.SENSOR_RESULT.DETECTED)) {
      // Should not be possible to simultanwously detect the door as both open and closed !!
      doorState = DOOR_STATE.UNKNOWN;
      _debug(`Door (${this.Name}): Sensor results are invalid. Both indicate detected !!`);
    }

    return doorState;
  }

  /* ========================================================================
     Description: Handler for Door Switch state changes, once debouncing is
                  complete.

     Parameters:  newDoorState: Updated Door State.

     Return:      None
     ======================================================================== */
  _updateDoorState(newDoorState) {
    // Cache the old state.
    const lastState = this.DoorState;
    // Update the door state and indicator
    this._currentDoorState = newDoorState;
    // Illuminate the Indicator LED if the Door is not closed.
    _gpiop.write(this._gpioChanStateIndicator, !this.DoorClosed);

    /* Clear the activation watchdog */
    if (this._doorActivationWatchdogId != undefined) {
      clearTimeout(this._doorActivationWatchdogId );
    }

    // Alert interested clients, asynchronously
    setTimeout((caller, previousState, newState) => {
      caller.emit('state_change', previousState, newState, caller);
    }, 0, this, lastState, this.DoorState);

    _debug(`(${this.Name}) Door State Change: Door is ${this.DoorState}`);
  }

  /* ========================================================================
   Description:    Validate the Detection Sensor configuration node

   Parameters:     configuration: Homebridge 'detect_sensors' sub-configuration

   Return:         true if the configuration is valid.
   ======================================================================== */
  _validateDetectionSensorConfig(configuration) {

    // Map of 'required' detection sensors.
    const requiredSensorsIdentified = new Map([['OPEN', false], ['CLOSE', false]]);

    // Require all configuration items to validate.
    let configValid = configuration.every((configItem) => {
      let configItemValid = ( (configItem.hasOwnProperty('id')       && (typeof(configItem.id)        === 'string'))  &&
                              (configItem.hasOwnProperty('class')    && (typeof(configItem.class)     === 'string'))  &&
                              (configItem.hasOwnProperty('function') && (typeof(configItem.function)  === 'string'))  &&
                              (configItem.hasOwnProperty('config')   && (typeof(configItem.config)    === 'object'))    );
      if (configItemValid) {
        // Validate the sensor-specific 'config' node.
        switch (configItem.class) {
          case 'SonarSensor':
          {
            configItemValid = _sonarSensor.ValidateConfiguration(configItem.config);
          }
          break;

          case 'ProximitySwitchSensor':
          {
            configItemValid = _proxSensor.ValidateConfiguration(configItem.config);
          }
          break;

          default:
          {
            _debug(`_validateDetectionSensorConfig: Config Item '${configItem.id}' unknown class:'${configItem.class}'`);
            configItemValid = false;
          }
          break;
        }

        // Determine if this detection sensor is one of the required items.
        if (configItemValid) {
          if (requiredSensorsIdentified.get(configItem.function.toUpperCase()) != undefined) {
              // This is one of our required entries.
              requiredSensorsIdentified.set(configItem.function.toUpperCase(), true);
          }
        }
      }

      if (!configItemValid) {
        // Stop evaluating.
        _debug(`_validateDetectionSensorConfig: Invalid configuration node. ${JSON.stringify(configItem)}`);
      }

      return configItemValid;
    });

    // Ensure that all required sensors were identified.
    requiredSensorsIdentified.forEach((value, key) => {
      configValid = configValid && value;
      if (!value) {
        _debug(`_validateDetectionSensorConfig: Required Sensor Function not found '${key}'`);
      }
    });

    return configValid;
  }

  /* ========================================================================
   Description:    Validate the Detection Sensor configuration node

   Parameters:     configuration:   Homebridge 'detect_sensors' sub-configuration
                   sensor_function: Which sensor to open.

   Return:         object reference to the detected sensor object being sought.
                   null if 'configuration' does not contain the item sought.
   ======================================================================== */
  _createDetectionSensor(configuration, sensor_function) {
    let sensor = null;

    const not_found = configuration.every((configItem) => {
      let keepLooking = true;
      if (configItem.function.toUpperCase() === sensor_function.toUpperCase()) {
        switch (configItem.class) {
          case 'SonarSensor':
          {
            _debug(`_createDetectionSensor: Creating Sonar Detection Sensor '${configItem.id}' '${configItem.function}' '${configItem.class}'`);
            sensor = new _sonarSensor(configItem.id, configItem.config);
          }
          break;

          case 'ProximitySwitchSensor':
          {
            _debug(`_createDetectionSensor: Creating MagProx Detection Sensor '${configItem.id}' '${configItem.function}' '${configItem.class}'`);
            sensor = new _proxSensor(configItem.id, configItem.config);
          }
          break;

          default:
          {
            _debug(`_createDetectionSensor: Config Item '${configItem.id}' unknown class. ${configItem.class}`);
          }
          break;
        }        // Done searching
        keepLooking = false;
      }

      return keepLooking;
    }, sensor);

    // If the sensor was not found, throw error.
    if (not_found) {
      throw new Error(`Unable to create detection sensor. function:${sensor_function} configuration:${JSON.stringify(configuration)}`);
    }

    return sensor;
  }
}

export {DoorController as default, DOOR_STATE};

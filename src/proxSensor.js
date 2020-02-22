/* ==========================================================================
   File:               proxSensor.js
   Class:              ProximitySwitch Sensor
   Description:	       Provide status and control of a proximity switch sensor
                       used for detection.
   Copyright:          Jun 2019
   ========================================================================== */
'use strict';

// External dependencies and imports.
const _gpio       = require('../node_modules/rpi-gpio');
const _gpiop      = _gpio.promise;
const _debug      = require('debug')('proxSensor');

// Internal dependencies
import _sensorBase, * as modSensorBase from './sensorBase.js';

/* Enumeration for Sonar Results */
const _PROX_SWITCH_MODE = {
  NORMALLY_OPEN   : false,
  NORMALLY_CLOSED : true
};

/* Default switch debounce time, in seconds */
const _DEFAULT_PROX_SWITCH_DEBOUNCE = 1.0/*sec*/;
/* Default to a normally closed switch */
const _DEFAULT_PROX_SWITCH_MODE     = _PROX_SWITCH_MODE.NORMALLY_CLOSED;

/* ProximitySwitchSensor represents Magnetic Proximity Switch Sensor.
   The sensor is monitored, and controlled by a RaspberryPi.

   @event 'distance_changed' => function(oldDistance, newDistance, context) {}
          Emitted when the sonar sensor detects a distance change that exceeds a change threshold.
          oldDistance: the prior distance measured in meters.
          newDistance: the updated distance measured in meters.
          context:     reference to the instance of the object raising the event.
*/
class ProximitySwitchSensor extends _sensorBase {
  /* ========================================================================
     Description: Constructor for an instance of a sonar sensor.

     Parameters:  identifier:                                 Identifier to associate with this object.
                  configuration:                              Object with the following fields.
                  { polling_interval:                         (Optional) Time in seconds that the sensor should be polled for a distance measurement.
                                                              Default: _DEFAULT_SONAR_POLLING_INTERVAL
                    distance_threshold_change_notification:   (Optional) Distance in meters to use as a change threshold for raising a distance_changed event.
                    trigger_out:                              GPIO Output Channel for the trigger to activate the sonar sensor.
                                                              ** Assumed to be in the GPIO Mode as the provider of the configuration.
                    echo_in:                                  GPIO Input Channel for to measure the door sonar sensor.
                                                              ** Assumed to be in the GPIO Mode as the provider of the configuration.
                    detect_threshold_min                      Minumum distance in meters to qualify as 'detected'.
                    detect_threshold_max                      Maximum distance in meters to qualify as 'detected'.
                  }
     Return:      N/A
     ======================================================================== */
  constructor(identifier, configuration) {

    // Initialize the base class.
    super(identifier);

    _debug(`Constructing prox switch sensor`);

    // Verify that the configuration is valid. Throws an exception if false.
    ProximitySwitchSensor.ValidateConfiguration(configuration);

    // Consume configuration
    /* Polling interval is optional. */
    this._switchDebounce  = (configuration.hasOwnProperty('debounce_time') ? configuration.debounce_time : _DEFAULT_PROX_SWITCH_DEBOUNCE) * 1000.0/* milliseconds / second */;
    /* Switch mode is optional. */
    this._switchMode      = (configuration.hasOwnProperty('mode') ? (configuration.mode ? _PROX_SWITCH_MODE.NORMALLY_CLOSED : _PROX_SWITCH_MODE.NORMALLY_OPEN) : _DEFAULT_PROX_SWITCH_MODE);
    /* GPIO channel to use for the switch signal. */
    this._gpioDetectIn    = configuration.detect_in;

    /* Prox Switch State Switch Debouce Timer Id */
    this._debounceTimerIdSwitchState  = undefined;
    /* Create a function pointer for state change notifications. */
    this._myStateChangeCB             = this._stateChange.bind(this);
  }

  /* ========================================================================
     Description: Destructor for an instance of a sonar sensor.

     Parameters:  None

     Return:      None

     Remarks:     DO NOT reset the underlying GPIO peripheral. That should only
                  be handled by the garage controller system. Simply make this
                  object inert and set the outputs back to default.
     ======================================================================== */
   async Terminate() {

    _debug(`Terminating Prox Sensor: ${this.Identifier}`);

    // Unregister for change notifications
    _gpio.off( 'change', this._myStateChangeCB );

    // Kill off any timers that may be pending
    if (this._debounceTimerIdSwitchState != undefined) {
      clearTimeout(this._debounceTimerIdSwitchState );
    }

    super._initialized = false;
  }

  /* ========================================================================
     Description: Start/Initialize the proximity switch sensor.

     Parameters:  None

     Return:      Flag indicating if the sensor has been initialized.
     ======================================================================== */
  async Start() {

    _debug(`Starting Prox Switch: ${this.Identifier}`);

    // Clear the initialized flag, in case we are re-starting
    super._initialized = false;

    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the sensor state input channel to observe
                          'detected and 'not detected' states */
                       _gpiop.setup(this._gpioDetectIn, _gpio.DIR_IN, _gpio.EDGE_BOTH)])
    .then(async (setupResults) => {
      /* Initialize the switch state */
      const switchState = await _gpiop.read(this._gpioDetectIn);
      return switchState;
    })
    .then(async (switchReadResult) => {
      _debug(`Prox Sensor:${this.Identifier}: switchReadResult=${switchReadResult} type=${typeof(switchReadResult)}`);
      // Update the switch result.
      this._updateSwitchState(switchReadResult);

      // Register for state change events for all input channels.
      _gpio.on( 'change', this._myStateChangeCB );

      // Indicate that the door is now initialized and ready to operate.
      super._initialized = true;
    })
    .catch((err) => {
      _debug(`Init Error(Prox Sensor:${this.Identifier}): ${err.toString()}`);
    });

    return this.Initialized;
  }

  /* ========================================================================
   Description:    Helper to convert the raw GPIO read into a SENSOR_RESULT

   Parameters:     rawReadValue: Raw GPIO reading for the switch.

   Return:         Corresponding SENSOR_RESULT.

   Remarks:        Takes sensor mode into account.
   ======================================================================== */
  _convertSwitchReadToDetected(rawReadValue) {
    // Normalize the 'raw' reading based upong the switch mode.
    const correctedRawRead = ((this._switchMode == _PROX_SWITCH_MODE.NORMALLY_CLOSED) ? rawReadValue : !rawReadValue);

    // Determine the sensor result.
    const result = (correctedRawRead ? modSensorBase.SENSOR_RESULT.DETECTED : modSensorBase.SENSOR_RESULT.UNDETECTED);

    return result;
  }

  /* ========================================================================
     Description: Event handler for State Change events on GPIO Inputs

     Parameters:  channel: GPIO Channel for the event.
                  value:   Value of the GPIO Input

     Return:      None
     ======================================================================== */
  _stateChange(channel, value) {
    switch (channel) {
      case (this._gpioDetectIn) :
      {
        // The switch state change may need to be debounced.
        // If a debounce timer is active/known, clear it.
        if (this._debounceTimerIdSwitchState != undefined) {
          clearTimeout(this._debounceTimerIdSwitchState);
        }
        _debug(`ProxSwitch (${this.Identifier}): _gpioDetectIn Change - Val:${value}`);

        // Schedule a new debounce timout and cache the timer id
        this._debounceTimerIdDoorState = setTimeout( ((reading) => { this._updateSwitchState(reading); }), this._switchDebounce, value );
      }
      break;

      default:
      {
        _debug(`ProxSwitch (${this.Identifier}): Unhandled State Change: Chan:${channel} Val:${value}`);
      }
      break;
    }
  }

  /* ========================================================================
     Description: Handler for prox switch state changes, once debouncing is
                  complete.

     Parameters:  rawReadResult: Raw GPIO Switch Reading

     Return:      None
     ======================================================================== */
  _updateSwitchState(rawSwitchReading) {
    // Update the switch result.
    super._setResult(this._convertSwitchReadToDetected(rawSwitchReading));
    _debug(`ProxSwitch ${this.Identifier} is: ${this.Result}`);
  }

  /* ========================================================================
   Description:    Validate the configuration for the proximity switch sensor

   Parameters:     configuration: Homebridge configuration node for a prox switch sensor

   Return:         true if configuration is valid

   Remarks:        Static method to allow configuration to be validated without creating an object instance
   ======================================================================== */
  static ValidateConfiguration(configuration) {
    const configValid = ( (!configuration.hasOwnProperty('debounce_time') || (typeof(configuration.debounce_time) === 'number') && (configuration.debounce_time >= 1.0))  && /* Optional configuration item */
                          (!configuration.hasOwnProperty('mode')          || (typeof(configuration.mode)          === 'boolean'))                                         && /* Optional configuration item */
                          ( configuration.hasOwnProperty('detect_in')     && (typeof(configuration.detect_in)     === 'number'))                                            );

    if (!configValid) {
      _debug(`ProximitySwitchSensor invalid configuration. configuration:${JSON.stringify(configuration)}`);
    }

    return configValid;
  }
}

export default ProximitySwitchSensor;

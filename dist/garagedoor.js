'use strict';

/* ==========================================================================
   File:               sensorBase.js
   Class:              SensorBase
   Description:	       Provide common status and control of detection sensors.
   Copyright:          Jun 2019
   ========================================================================== */

// External dependencies and imports.
const EventEmitter  = require('events').EventEmitter;
const _debug        = require('debug')('sensorBase');

/* Enumeration for Sonar Results */
const SENSOR_RESULT = {
  UNKNOWN    : 'UNKNOWN',
  UNDETECTED : 'UNDETECTED',
  DETECTED   : 'DETECTED'
};

/* SensorBase represents a base class of detection sensors.

   @event 'result_changed'  => function(oldResult, newResult, context) {}
          Emitted when the sensor detects a state change.
          oldResult:   the prior SENSOR_RESULT
          newResult:   the new SENSOR_RESULT
          context:    reference to the instance of the object raising the event.
*/
class SensorBase extends EventEmitter {
  /* ========================================================================
     Description: Constructor for an instance of a detection sensor.

     Parameters:  identifier: Identifier to associate with this object.
     Return:      N/A
     ======================================================================== */
  constructor(identifier) {

    // Initialize the base class.
    super();

    // Assign the identifier.
    this._id = identifier;

    this._initialized = false;

    // Initialize the result
    this._result = SENSOR_RESULT.UNKNOWN;
  }

  /* ========================================================================
     Description: Property for Sonar Sensor Result

     Parameters:  None

     Return:      Last know SENSOR_RESULT
     ======================================================================== */
  get Result() {
    return (this._result);
  }

  /* ========================================================================
     Description: Read-Only Property for the identifier of this sensor

     Parameters:  None

     Return:      Identifier of this object
     ======================================================================== */
  get Identifier() {
    return this._id;
  }

  /* ========================================================================
     Description: Read-Only Property for the initialized state of this sensor

     Parameters:  None

     Return:      Initialized of this object
     ======================================================================== */
  get Initialized() {
    return this._initialized;
  }

  /* ========================================================================
     Description: Internal helper to update the cached result and notify
                  registered clients of the 'results_changed' event.

     Parameters:  newResult: The updated Sensor Result.

     Return:      None.

     Remarks:     Intended to only be invoked from objects deriving from this class.
     ======================================================================== */
  _setResult(newResult) {

    const oldResult = this._result;

    if (oldResult != newResult) {
      // Update the cached result.
      this._result = newResult;

      // Notify clients - asynchronously.
      setTimeout((caller, resultOld, resultNew) => {
        caller.emit('result_changed', resultOld, resultNew, caller);
      }, 0, this, oldResult, newResult);
    }
  }
}

/* ==========================================================================
   File:               proxSensor.js
   Class:              ProximitySwitch Sensor
   Description:	       Provide status and control of a proximity switch sensor
                       used for detection.
   Copyright:          Jun 2019
   ========================================================================== */

// External dependencies and imports.
const _gpio       = require('../node_modules/rpi-gpio');
const _gpiop      = _gpio.promise;
const _debug$1      = require('debug')('proxSensor');

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
*/
class ProximitySwitchSensor extends SensorBase {
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

    _debug$1(`Constructing prox switch sensor`);

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

    _debug$1(`Terminating Prox Sensor: ${this.Identifier}`);

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

    _debug$1(`Starting Prox Switch: ${this.Identifier}`);

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
      _debug$1(`Prox Sensor:${this.Identifier}: switchReadResult=${switchReadResult} type=${typeof(switchReadResult)}`);
      // Update the switch result.
      this._updateSwitchState(switchReadResult);

      // Register for state change events for all input channels.
      _gpio.on( 'change', this._myStateChangeCB );

      // Indicate that the door is now initialized and ready to operate.
      super._initialized = true;
    })
    .catch((err) => {
      _debug$1(`Init Error(Prox Sensor:${this.Identifier}): ${err.toString()}`);
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
    const result = (correctedRawRead ? SENSOR_RESULT.DETECTED : SENSOR_RESULT.UNDETECTED);

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
        _debug$1(`ProxSwitch (${this.Identifier}): _gpioDetectIn Change - Val:${value}`);

        // Schedule a new debounce timout and cache the timer id
        this._debounceTimerIdDoorState = setTimeout( ((reading) => { this._updateSwitchState(reading); }), this._switchDebounce, value );
      }
      break;

      default:
      {
        _debug$1(`ProxSwitch (${this.Identifier}): Unhandled State Change: Chan:${channel} Val:${value}`);
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
    _debug$1(`ProxSwitch ${this.Identifier} is: ${this.Result}`);
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
      _debug$1(`ProximitySwitchSensor invalid configuration. configuration:${JSON.stringify(configuration)}`);
    }

    return configValid;
  }
}

/* ==========================================================================
   File:               sonarSensor.js
   Class:              SonarSensor
   Description:	       Provide status and control of a sonar sensor used for
                       detection.
   Copyright:          Jun 2019
   ========================================================================== */

// External dependencies and imports.
const _gpio$1       = require('../node_modules/rpi-gpio');
const _gpiop$1      = _gpio$1.promise;
const _debug$2      = require('debug')('sonarSensor');

// Enumeration for managing the current sonar signal.
const _SONAR_STATE = {
  INACTIVE  : 'INACTIVE',
  ARMED     : 'ARMED',    /* Waiting for rising edge  */
  PENDING   : 'PENDING'   /* Waiting for falling edge */
};

/* The nominal speed of sound in air @20 degC */
const _NOMINAL_SPEED_OF_SOUND                     = 343.0/*meters per sec*/;
/* Minimum polling interval of the sonar sensor. Accounts for the 100ms maximum detection interval of the HS204 */
const _MINIMUM_SONAR_POLLING_INTERVAL             =  0.25/*sec*/;
/* Default polling interval of the sonar sensor */
const _DEFAULT_SONAR_POLLING_INTERVAL             =  5.0/*sec*/;
/* Change threshold to determine when the 'distance_changed' event should be raised. */
const _DISTANCE_THRESHOLD_FOR_CHANGE_NOTIFICATION = 0.08/*meters*/;
/* Time for toggling the trigger to initiate a sonar reading. */
const _SONAR_TRIGGER_TIME                         =  1/*ms*/;
/* Distance used to indicate an invalid distance measurement. */
const _INVALID_DISTANCE                           = -1000.0/*meters*/;


/* SonarSenaor represents a HS204 Sonar Sensor. The sensor is monitored,
   and controlled by a RaspberryPi.

   @event 'distance_changed' => function(oldDistance, newDistance, context) {}
          Emitted when the sonar sensor detects a distance change that exceeds a change threshold.
          oldDistance: the prior distance measured in meters.
          newDistance: the updated distance measured in meters.
          context:     reference to the instance of the object raising the event.
*/
class SonarSensor extends SensorBase {
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

    _debug$2(`Constructing sonar sensor`);

    // Verify that the configuration is valid. Throws an exception if false.
    SonarSensor.ValidateConfiguration(configuration);

    // Consume configuration
    /* Polling interval is optional. */
    this._sonarPingInterval = (configuration.hasOwnProperty('polling_interval') ? configuration.polling_interval : _DEFAULT_SONAR_POLLING_INTERVAL) * 1000.0/* milliseconds / second */;
    /* Distance threshold change notification is optional */
    this._distanceThreshold = (configuration.hasOwnProperty('distance_threshold_change_notification') ? configuration.distance_threshold_change_notification : _DISTANCE_THRESHOLD_FOR_CHANGE_NOTIFICATION);
    this._gpioTriggerOut    = configuration.trigger_out;
    this._gpioEchoIn        = configuration.echo_in;
    this._detectMin         = configuration.detect_threshold_min;
    this._detectMax         = configuration.detect_threshold_max;

    // Other data members
    this._initialize();

    /* Create a function pointer for state change notifications. */
    this._myStateChangeCB   = this._stateChange.bind(this);

    _debug$2(`New Sonar Sensor: id=${this.Identifier}`);
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

    _debug$2(`Terminating Sonar Sensor: ${this.Identifier}`);

    // Stop the sonar.
    this.Active = false;

    // Unregister for change notifications
    _gpio$1.off( 'change', this._myStateChangeCB );

    super._initialized = false;
  }

  /* ========================================================================
     Description: Start/Initialize the sonar sensor.

     Parameters:  None

     Return:      Flag indicating if the sensor has been initialized.
     ======================================================================== */
  async Start() {

    _debug$2(`Starting Sonar: ${this.Identifier}`);

    // Re-initialize the internal data.
    this._initialize();

    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the sonar trigger and initialize to LOW */
                       _gpiop$1.setup(this._gpioTriggerOut, _gpio$1.DIR_LOW),
                       /* Configure the door sonar echo input channel to detect all events to allow
                          for the measurement of the pulse duration, which equates to distance. */
                       _gpiop$1.setup(this._gpioEchoIn,     _gpio$1.DIR_IN,  _gpio$1.EDGE_BOTH),
                      ])
    .then(async (setupResults) => {
      // Register for state change events for all input channels.
      _gpio$1.on( 'change', this._myStateChangeCB );

      // Start the sonar measuring system.
      this.Active = true;

      // Indicate that the sonar is now initialized and ready to operate.
      super._initialized = true;
    })
    .catch((err) => {
      _debug$2(`Init Error(Sonar:${this.Identifier}): ${err.toString()}`);
    });

    return this.Initialized;
  }

  /* ========================================================================
     Description: Property for Sonar Sensor Activation

     Parameters:  None

     Return:      true if the sonar is active. false otherwise.
     ======================================================================== */
  get Active() {
    let active = false;

    if (this._sonarPingTriggerId) {
      active = true;
    }
    return (active);
  }

  /* ========================================================================
     Description: Property for Sonar Sensor Activation

     Parameters:  active: Flag indicating if the sonar should be active or not.

     Return:      None
     ======================================================================== */
  set Active(active) {
    let reset = !active;
    if (active && !this.Active)
    {
      /* Requesting to activate an inactive sonar. */
      this._sonarPingTriggerId = setInterval( (() => {this._triggerSonar(); }), this._sonarPingInterval);
      // Also reset the data if activating the sonar sensor.
      reset = true;
    }
    else if (!active && this.Active)
    {
      /* Requesting to deactivate an active sonar */
      this._sonarPingTriggerId = clearInterval(this._sonarPingTriggerId);
    }
    else {
      _debug$2(`Sonar ${this.Identifier}: Sonar is already ${active ? 'active' : 'inactive'}`);
    }

    // Clear the sonar data if inactive or newly activated.
    if (reset)
    {
      this._lastDistanceReading       = _INVALID_DISTANCE;
      this._referenceDistanceReading  = _INVALID_DISTANCE;
      this._referenceTime             = 0;
      this._distanceAge               = 0;
      this._sonarState                = _SONAR_STATE.INACTIVE;
    }
  }

  /* ========================================================================
     Description: Helper to initialize the internal data. Used to support re-starting.

     Parameters:  None

     Return:      None
     ======================================================================== */
  _initialize() {
    super._initialized  = false;
    this.Active         = false;
  }

  /* ========================================================================
     Description: Trigger the door sonar signal to initiate a reading.

     Parameters:  None

     Return:      None
     ======================================================================== */
  _triggerSonar() {
    // The door sonar activates with an active high signal.
    const ACTIVATE_SONAR = true;

    // Ensure that the sonar is not busy.
    if (this._sonarState != _SONAR_STATE.INACTIVE)
    {
      // Trigger is occuring during an existing reading.
      this.Active = false;
      _debug$2(`Sonar (${this.Identifier}) Unexpected trigger request.`);
    }
    try {
      // Trigger the sonar.
      _gpiop$1.write(this._gpioTriggerOut, ACTIVATE_SONAR)
      .then(() => {
        // Once active, deactivate the sonar after a brief period.
        return setTimeout(_gpiop$1.write, _SONAR_TRIGGER_TIME, this._gpioTriggerOut, !ACTIVATE_SONAR);
      })
      .then(() => {
        // Set the Sonar State to armed.
        this._sonarState = _SONAR_STATE.ARMED;
      })
      .catch((error) => {
        this.Active = false;
        _debug$2(`Sonar (${this.Identifier}) Request Error: ${error.toString()}`);
      });
    }
    catch (err) {
      this.Active = false;
      _debug$2(`Failed to trigger Sonar (${this.Identifier}): (${err})`);
    }
    finally {
      // Restart the sonar if it deactivated due to an error.
      if (!this.Active) {
        _debug$2(`Sonar (${this.Identifier}) Restart sonar`);
        this.Active = true;
      }
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
      case (this._gpioEchoIn) :
      {
        if (this.Active) {
          switch (this._sonarState) {
            case _SONAR_STATE.ARMED :
            {
              if (value) {
                /* The sonar data is Armed. So cache the current time and
                   set the state to PENDING (waiting for final reading) */
                this._referenceTime = Date.now();
                this._sonarState    = _SONAR_STATE.PENDING;
              }
              else {
                _debug$2(`Sonar (${this.Identifier}): Object too close. Forcing measurement distance of half of the detectable minimum.`);

                /* Perform the distance measurement forcing half the minimum resolution. (JavaScript limitation) */
                this._performDistanceMeasurement(0.5, Date.now());

                // Force the sensor to re-activate.
                this.Active = false;
              }
            }
            break;

            case _SONAR_STATE.PENDING :
            {
              if (!value) {
                /* The sonar data is pending (waiting for the measurement to complete). */
                /* Get the elapsed time while in the armed state. */
                const measurementCompleteTime = Date.now();
                const elapsedTime = measurementCompleteTime - this._referenceTime;

                /* Perform the distance measurement */
                this._performDistanceMeasurement(elapsedTime, measurementCompleteTime);

                /* Set the state back to INACTIVE. */
                this._sonarState = _SONAR_STATE.INACTIVE;
              }
              else {
                _debug$2(`Sonar (${this.Identifier}): Unexpected GPIO Signal when Pending.`);
                this.Active = false;
              }
            }
            break;

            case _SONAR_STATE.INACTIVE :
            // Break intentionally missing
            default:
            {
              this.Active = false;
            }
            break;
          }

          // Restart if we became active in this cycle.
          if (!this.Active) {
            this.Active = true;
          }
        }
        else {
          _debug$2(`Sonar (${this.Identifier}): Unexpected GPIO Signal when Not Active.`);
        }
      }
      break;

      default:
      {
        _debug$2(`Sonar (${this.Identifier}): Unhandled State Change: Chan:${channel} Val:${value}`);
      }
      break;
    }
  }

  /* ========================================================================
     Description: Helper to compute the measured distance and notify clients
                  as needed.

     Parameters:  elapsedTime:              Time elapsed, in milli-seconds, that the distance
                                            measurement was monitored.
                  measurementCompleteTime:  Time of measurement completion, in milli-seconds.

     Return:      None
     ======================================================================== */
  _performDistanceMeasurement(elapsedTime, measurementCompleteTime) {
    /* Distance factor: The sonar must travel to the target and return.
     Therefore the total distance traveled is 2x the distance to the target. */
    const DISTANCE_FACTOR = 2.0;

    /* Convert the elapsed time to distance and cache the time of the measurement. */
    this._lastDistanceReading = (_NOMINAL_SPEED_OF_SOUND * (elapsedTime / 1000.0/* sec / ms */)) / DISTANCE_FACTOR;
    this._distanceAge         = measurementCompleteTime;

    // Raise the distance_changed event, if appropriate.
    if (Math.abs(this._lastDistanceReading - this._referenceDistanceReading) >= this._distanceThreshold) {
      // Raise the event, asynchronously.
      setTimeout((caller, resultOld, resultNew) => {
        caller.emit('distance_changed', resultOld, resultNew, caller);
      }, 0, this, this._referenceDistanceReading, this._lastDistanceReading);

      /* Update the reference distance */
      this._referenceDistanceReading = this._lastDistanceReading;
    }

    // Compute the sensor state.
    const newResult = (((this._lastDistanceReading >= this._detectMin) &&
                        (this._lastDistanceReading <= this._detectMax)) ? SENSOR_RESULT.DETECTED : SENSOR_RESULT.UNDETECTED);
    _debug$2(`Sonar (${this.Identifier}): Measured Distance=${this._lastDistanceReading} Result=${newResult}`);

    // Update the result & raise the result_changed event, if appropriate.
    super._setResult(newResult);
  }

  /* ========================================================================
   Description:    Validate the configuration for the sonar sensor

   Parameters:     configuration: Homebridge configuration node for a sonar sensor

   Return:         true if configuration is valid

   Remarks:        Static method to allow configuration to be validated without creating an object instance
   ======================================================================== */
  static ValidateConfiguration(configuration) {
    const configValid = ( (!configuration.hasOwnProperty('polling_interval')                        || ((typeof(configuration.polling_interval)                        === 'number')  && (configuration.polling_interval >= _MINIMUM_SONAR_POLLING_INTERVAL)))  && /* Optional configuration item */
                          (!configuration.hasOwnProperty('distance_threshold_change_notification')  || ((typeof(configuration.distance_threshold_change_notification)  === 'number')  && (configuration.distance_threshold_change_notification > 0.0)))         && /* Optional configuration item */
                          ( configuration.hasOwnProperty('trigger_out')                             &&  (typeof(configuration.trigger_out)                             === 'number'))                                                                           &&
                          ( configuration.hasOwnProperty('echo_in')                                 &&  (typeof(configuration.echo_in)                                 === 'number'))                                                                           &&
                          ( configuration.hasOwnProperty('detect_threshold_min')                    &&  (typeof(configuration.detect_threshold_min)                    === 'number')  && (configuration.detect_threshold_min >= 0.0))                           &&
                          ( configuration.hasOwnProperty('detect_threshold_max')                    &&  (typeof(configuration.detect_threshold_max)                    === 'number')  && (configuration.detect_threshold_max >  0.0))                           &&
                          (configuration.detect_threshold_max > configuration.detect_threshold_min)                                                                                                                                                               );

    if (!configValid) {
      _debug$2(`SonarSensor invalid configuration. configuration:${JSON.stringify(configuration)}`);
    }

    return configValid;
  }
}

/* ==========================================================================
   File:        doorCntrl.js
   Class:       Door Controller
   Description: Provides status and control of a garage door via
                Raspberry PI GPIO.
   Copyright:   May 2019
   ========================================================================== */

// External dependencies and imports.
const EventEmitter$1  = require('events').EventEmitter;
const _gpio$2         = require('../node_modules/rpi-gpio');
const _gpiop$2        = _gpio$2.promise;
const _debug$3        = require('debug')('doorCntrl');

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
class DoorController extends EventEmitter$1 {
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

    _debug$3(`Constructing door`);

    // Validate the supplied configuration.
    const configValid = ( (configuration.hasOwnProperty('name')                  && (typeof(configuration.name)                  === 'string'))                                               &&
                          (configuration.hasOwnProperty('state_indicator')       && (typeof(configuration.state_indicator)       === 'number'))                                               &&
                          (configuration.hasOwnProperty('control_request')       && (typeof(configuration.control_request)       === 'number'))                                               &&
                          (configuration.hasOwnProperty('manual_control_reqest') && (typeof(configuration.manual_control_reqest) === 'number'))                                               &&
                          (configuration.hasOwnProperty('detect_sensors')        && (typeof(configuration.detect_sensors)        === 'object') && (configuration.detect_sensors.length >= 2)) &&
                          (this._validateDetectionSensorConfig(configuration.detect_sensors))                                                                                                   );
    if (!configValid) {
      _debug$3(`DoorController invalid configuration. configuration:${JSON.stringify(configuration)}`);
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
    /* Soft-Lock State */
    this._doorLocked                = false;
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

    _debug$3(`New Door: name=${this.Name}`);
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

    _debug$3(`Terminating Door: ${this.Name}`);

    // Unregister for change notifications
    _gpio$2.off( 'change', this._myStateChangeCB );

    // Unregister for the sensor events.
    this._openSensor.off(   'result_changed',   this._mySensorResultChangedCB);
    this._closedSensor.off( 'result_changed',   this._mySensorResultChangedCB);

    // Kill the detection sensors.
    this._openSensor.Terminate();
    this._closedSensor.Terminate();

    // Kill off any timers that may be pending
    if (this._debounceTimerIdDoorCntrl) {
      clearTimeout(this._debounceTimerIdDoorCntrl );
    }
    await Promise.all([/* The Door State Indicator is Active Low. */
                 _gpiop$2.write(this._gpioChanStateIndicator, false),
                 // The Door Control request is Active High.
                 _gpiop$2.write(this._gpioChanCtrlRequest, true)])
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

    _debug$3(`Starting Door: ${this.Name}`);

    // Clear the initialized flag, in case we are re-starting
    this._initialized        = false;

    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the door state indicator channel */
                       _gpiop$2.setup(this._gpioChanStateIndicator, _gpio$2.DIR_LOW),
                       /* Configure the door control channel and initialize to HIGH */
                       _gpiop$2.setup(this._gpioChanCtrlRequest,    _gpio$2.DIR_HIGH),
                       /* Configure the door request button input channel to detect release events */
                       _gpiop$2.setup(this._gpioManualCtrlRequest,  _gpio$2.DIR_IN,  _gpio$2.EDGE_RISING),
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
      _debug$3(`Door ${this.Name} is: ${this.DoorState}`);
      // Illuminate the Indicator LED if the Door is open.
      await _gpiop$2.write(this._gpioChanStateIndicator, this.DoorOpen);
      // Register for state change events for all input channels.
      _gpio$2.on( 'change', this._myStateChangeCB );

      // Indicate that the door is now initialized and ready to operate.
      this._initialized = true;
    })
    .catch((err) => {
      _debug$3(`Init Error(Door:${this.Name}): ${err.toString()}`);
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
          const ledState = await _gpiop$2.read(this._gpioChanStateIndicator);
          // Update the Door Status LED for idenfification
          await _gpiop$2.write(this._gpioChanStateIndicator, !ledState);
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
      _debug$3(`Activating Door: ${this.Name}`);

      /* Clear the activation watchdog */
      if (this._doorActivationWatchdogId != undefined) {
        clearTimeout(this._doorActivationWatchdogId );
      }

      // Activate the relay.
      _gpiop$2.write(this._gpioChanCtrlRequest, ACTIVATE_RELAY)
      .then(() => {
        // Once active, deactivate the relay after the appropriate delay.
        return setTimeout(_gpiop$2.write, _DOOR_CTRL_REQ_TIME, this._gpioChanCtrlRequest, !ACTIVATE_RELAY);
      })
      .catch((error) => {
        _debug$3(`(${this.Name}) Door Request Error: ${error.toString()}`);
      });

      // Once activated, set a watchdog in case the door does not respond.
      this._doorActivationWatchdogId = setTimeout( ((oldDoorState) => { this._updateDoorState(oldDoorState); }), _DOOR_ACTIVATION_TIMEOUT, this.DoorState );
    }
    else {
      _debug$3(`Door ${this.Name}: Cannot activate door. Not initialized or is locked. Initialized:${this.Initialized} Locked:${this.DoorLocked}`);
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
        _debug$3(`Door (${this.Name}) Unhandled State Change. Chan:${channel} Val:${value}`);
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

    _debug$3(`Door (${this.Name}): Sensor ${context.Identifier} result changed. Old:${oldResult} New:${newResult} OldDoorState:${this.DoorState} NewDoorState:${newDoorState}`);

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

    _debug$3(`Door (${this.Name}): _determineDoorState openResult=${openResult} closedResult=${closedResult}`);

    // Based on the last known door state and the current sensor results,
    // determine the new current door state.
    if ((openResult   === SENSOR_RESULT.UNKNOWN) &&
        (closedResult === SENSOR_RESULT.UNKNOWN)) {
      // Door State is unknown.
      doorState = DOOR_STATE.UNKNOWN;
    }
    else if ((openResult   === SENSOR_RESULT.UNKNOWN) &&
             (closedResult === SENSOR_RESULT.UNDETECTED)) {
      // Not conclusive, but assume the door is open.
      doorState = DOOR_STATE.OPEN;
    }
    else if ((openResult   === SENSOR_RESULT.UNKNOWN) &&
             (closedResult === SENSOR_RESULT.DETECTED)) {
      // Door is closed.
      doorState = DOOR_STATE.CLOSED;
    }
    else if ((openResult   === SENSOR_RESULT.UNDETECTED) &&
             (closedResult === SENSOR_RESULT.UNKNOWN)) {
      // Not conclusive, but assume the door is closed.
      doorState = DOOR_STATE.CLOSED;
    }
    else if ((openResult   === SENSOR_RESULT.UNDETECTED) &&
             (closedResult === SENSOR_RESULT.UNDETECTED)) {
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
      }
    }
    else if ((openResult   === SENSOR_RESULT.UNDETECTED) &&
             (closedResult === SENSOR_RESULT.DETECTED)) {
      // Door is closed.
      doorState = DOOR_STATE.CLOSED;
    }
    if ((openResult   === SENSOR_RESULT.DETECTED) &&
        (closedResult === SENSOR_RESULT.UNKNOWN)) {
      // Door State is open.
      doorState = DOOR_STATE.OPEN;
    }
    else if ((openResult   === SENSOR_RESULT.DETECTED) &&
             (closedResult === SENSOR_RESULT.UNDETECTED)) {
      // Door is open
      doorState = DOOR_STATE.OPEN;
    }
    else if ((openResult   === SENSOR_RESULT.DETECTED) &&
             (closedResult === SENSOR_RESULT.DETECTED)) {
      // Should not be possible to simultanwously detect the door as both open and closed !!
      doorState = DOOR_STATE.UNKNOWN;
      _debug$3(`Door (${this.Name}): Sensor results are invalid. Both indicate detected !!`);
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
    _gpiop$2.write(this._gpioChanStateIndicator, !this.DoorClosed);

    /* Clear the activation watchdog */
    if (this._doorActivationWatchdogId != undefined) {
      clearTimeout(this._doorActivationWatchdogId );
    }

    // Alert interested clients, asynchronously
    setTimeout((caller, previousState, newState) => {
      caller.emit('state_change', previousState, newState, caller);
    }, 0, this, lastState, this.DoorState);

    _debug$3(`(${this.Name}) Door State Change: Door is ${this.DoorState}`);
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
            configItemValid = SonarSensor.ValidateConfiguration(configItem.config);
          }
          break;

          case 'ProximitySwitchSensor':
          {
            configItemValid = ProximitySwitchSensor.ValidateConfiguration(configItem.config);
          }
          break;

          default:
          {
            _debug$3(`_validateDetectionSensorConfig: Config Item '${configItem.id}' unknown class:'${configItem.class}'`);
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
        _debug$3(`_validateDetectionSensorConfig: Invalid configuration node. ${JSON.stringify(configItem)}`);
      }

      return configItemValid;
    });

    // Ensure that all required sensors were identified.
    requiredSensorsIdentified.forEach((value, key) => {
      configValid = configValid && value;
      if (!value) {
        _debug$3(`_validateDetectionSensorConfig: Required Sensor Function not found '${key}'`);
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
            _debug$3(`_createDetectionSensor: Creating Sonar Detection Sensor '${configItem.id}' '${configItem.function}' '${configItem.class}'`);
            sensor = new SonarSensor(configItem.id, configItem.config);
          }
          break;

          case 'ProximitySwitchSensor':
          {
            _debug$3(`_createDetectionSensor: Creating MagProx Detection Sensor '${configItem.id}' '${configItem.function}' '${configItem.class}'`);
            sensor = new ProximitySwitchSensor(configItem.id, configItem.config);
          }
          break;

          default:
          {
            _debug$3(`_createDetectionSensor: Config Item '${configItem.id}' unknown class. ${configItem.class}`);
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

/* ==========================================================================
   File:        garageSystem.js
   Class:       Garage Controller System
   Description: Provides command and control of multiple garage doors,
                temerature, etc. via Raspberry PI GPIO.
   Copyright:   May 2019
   ========================================================================== */

// External dependencies and imports.
const EventEmitter$2  = require('events').EventEmitter;
const _gpio$3         = require('../node_modules/rpi-gpio');
const _gpiop$3        = _gpio$3.promise;
const _debug$4        = require('debug')('garageSystem');

/* Enumeration for LED States */
const LED_STATE = {
  OFF : 0,
  ON  : 1
};

/* Time interval for the activity heartbeat */
const _HEARTBEAT_INTERVAL      = 500/*ms*/;
/* Total time for the door identification process */
const _GARAGE_SYSTEM_TOTAL_IDENTIFICATION_TIMEOUT    = 5000/*ms*/;
/* Time for toggling the door state LED when identifying the door */
const _GARAGE_SYSTEM_IDENTIFICATION_TOGGLE_TIMEOUT   =  100/*ms*/;

/* GPIO Channel for the activity heartbeat indicator */
const _DEFAULT_HEARTBEAT_CTRL  = 4/*GPIO4, assuming BCM Mode */;

/* ========================================================================
   Description: Helper function to perform a delay

   Parameters:  timeout:  Delay in milliseconds.

   Return:      Promise.

   Remarks:     Assumed to be executed via async/await.
   ======================================================================== */
const _delay$1 = timeout => new Promise( resolveDelay => { setTimeout(resolveDelay, timeout); });

/* GarageSystem represents a garage control system configured, monitored,
   and controlled by a RaspberryPi.

   @event 'door_state_change' => function(oldState, newState, context) {}
          Emitted when the door changes its open/closed states.
          Context will be the name of the door raising the event.
*/
class GarageSystem extends EventEmitter$2 {
  /* ========================================================================
     Description: Constructor for an instance of a garage control system.

     Parameters:  None

     Return:      N/A
     ======================================================================== */
  constructor() {
    _debug$4('Creating Garage Door Control System.');

    // Initialize the base class.
    super();

    // Initialize members.
    this._heartbeatLEDState   = LED_STATE.OFF;
    this._myDoor              = undefined;
    this._initialized         = false;
    this._doorControllers     = new Map();
    this._heartbeatIntervalId = undefined;

    // Configuration members.
    this.heartbeatControlChannelId =_DEFAULT_HEARTBEAT_CTRL;

    /* Create a function pointer for state change notifications. */
    this._bindDoorStateChange  = this.doorStateChange.bind(this);
  }

  /* ========================================================================
     Description: Desctuctor for an instance of a garage door control system.

     Parameters:  None

     Return:      None.
     ======================================================================== */
  async Terminate() {

    _debug$4('Terminating Garage Door Control System.');

    /* Clean up the doors */
    this._doorControllers.forEach(async (door) => {
      _debug$4(`Killing door: ${door.Name}`);
      await door.Terminate();
    });
    /* Clear out the map */
    this._doorControllers.clear();

    /* Kill the heartbeat. */
    if (this._heartbeatIntervalId != undefined) {
      clearInterval(this._heartbeatIntervalId);
      this._heartbeatIntervalId = undefined;
    }
    /* ...and turn off the indicator. */
    await _gpiop$3.write(this.heartbeatControlChannelId, LED_STATE.OFF)
    .then (() => {
      /* Do Nothing. Synchronous operation. */
    });

    /* Clean up the GPIO resources. */
    try {
      _gpio$3.reset();
    }
    catch(error) {
      _debug$4(`Error when resetting gpio: (${error.toString()})`);
    }
    finally {
      await _gpiop$3.destroy()
      .then (() => {
        /* Do Nothing. Synchronous operation. */
      })
      .catch ((error) => {
        _debug$4(`Error when destroying gpio: (${error.toString()})`);
      })
      .finally (() => {
        /* Indicate that we are no logner initialized. */
        this._initialized = false;
      });
    }
  }

  /* ========================================================================
     Description: Start/Initialize the door system.

     Parameters:  config: Homebridge system configuration data

     Return:      Flag indicating if the door has been initialized.
     ======================================================================== */
  async Start(config) {

    _debug$4('Starting Garage Door Control System.');

    // Validate the configuration provided.
    let gpioMode = _gpio$3.MODE_BCM;  // Default to BCM Mode
    if (config.hasOwnProperty('gpio_mode')) {
      // Get the GPIO mode from the configuration. {Optional}
      switch (config.gpio_mode) {
        case 'BCM':
        {
          gpioMode = _gpio$3.MODE_BCM;
        }
        break;

        case 'RPI':
        {
          gpioMode = _gpio$3.MODE_RPI;
        }
        break;

        default:
        {
          // Use the default.
          _debug$4(`GarageSystem: Invalid setting for 'gpio_mode' configuration ${config.gpio_mode}`);
        }
        break;
      }
    }
    // Get the GPIO Channel Id for the heartbeat control.
    if (config.hasOwnProperty('heartbeat')) {
      // Get the Heartbeat Channel Id from the configuration. {Optional}
      this.heartbeatControlChannelId = config.heartbeat;
    }
    // Get the number of doors. There must be at least one.
    let doorConfigs = new Array();
    if ((config.hasOwnProperty('doors')) &&
        (typeof(config.doors) === 'object')) {

      doorConfigs = config.doors;
      if (doorConfigs.length <= 0) {
        _debug$4(`GarageSystem: Invalid door configuration. doors:${JSON.stringify(config)}`);
      }
    }

    // Initialize the hardware.
    _gpio$3.setMode(gpioMode);
    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the heartbeat channel */
                       _gpiop$3.setup(this.heartbeatControlChannelId, _gpio$3.DIR_LOW)])
      .then(async (setupResults) => {
          const result = await Promise.all([/* Initialize the heartbeat LED state */
                                            _gpiop$3.write(this.heartbeatControlChannelId, this._heartbeatLEDState)]);
          return result;
      })
      .then(async (initResults) => {
          // Activate a recurring timer for controlling the heartbeat.
          this._heartbeatIntervalId = setInterval((() => { this.doHeartbeat(); }), _HEARTBEAT_INTERVAL);

          // Maintain an array of promises for each door started.
          const doorStartPromises = new Array();
          // Create & start all of the doors.
          doorConfigs.forEach((doorConfig) => {
            // Create the door
            const newDoor = new DoorController(doorConfig);

            // Register for event notification on the door controllers.
            newDoor.on( 'state_change', this._bindDoorStateChange );

            // Start the door.
            const doorResult = newDoor.Start();
            doorStartPromises.push(doorResult);

            // Cache the door for use later on.
            this._doorControllers.set(newDoor.Name, newDoor);
          });

          // Wait for all of the doors to complete their promise.
          await Promise.all(doorStartPromises)
          .then((initResults) => {
            // The system is only initialized iff _all_ of the door controllers were initialized.
            let initialized = true;
            initResults.forEach((init) =>{
              if (!init) {
                initialized = init;
              }
            });

            // The system is only initialized if all of the Door Controllers are initialized.
            this._initialized = initialized;
          })
          .catch((err) => {
              _debug$4('Init Error (Garage System waiting for doors): ', err.toString());
          });
      })
      .catch((err) => {
          _debug$4('Init Error (Garage System): ', err.toString());
      });

      return this._initialized;
  }

  /* ========================================================================
     Description: Read-Only Property for a list of names of the dor controllers.

     Parameters:  None

     Return:      List of names of the garage door controllers.
     ======================================================================== */
  get DoorControllers() {
    const controllerNames = [];

    // Iterate the door controllers and provide the list of names.
    this._doorControllers.forEach((door) => {
      controllerNames.push(door.Name);
    });

    return controllerNames;
  }

  /* ========================================================================
     Description: Property for Garage System Initialized

     Parameters:  None

     Return:      true if the the garage system is initialized. false otherwise.
     ======================================================================== */
  get Initialized() {
    return this._initialized;
  }

  /* ========================================================================
     Description: Identify the garage system

     Parameters:  None

     Return:      Promise function. resolves true if initialized. false otherwise.

     Remarks:     Identify by flashing the heartbeat LED. This function runs asynchronously.
     ======================================================================== */
  Identify() {
    return new Promise(async resolve => {
      if (this.Initialized) {
        // Total number of LED toggle cycles needed for identification.
        const IDENTIFICATION_TOGGLE_CYCLES = _GARAGE_SYSTEM_TOTAL_IDENTIFICATION_TIMEOUT / _GARAGE_SYSTEM_IDENTIFICATION_TOGGLE_TIMEOUT;

        // Suspend the heartbeat.
        if (this._heartbeatIntervalId != undefined) {
          clearInterval(this._heartbeatIntervalId);
          this._heartbeatIntervalId = undefined;
        }

        for (let count=0; count < IDENTIFICATION_TOGGLE_CYCLES; count++) {
          // Get the current LED State.
          const ledState = await _gpiop$3.read(this.heartbeatControlChannelId);

          // Update the Door Status LED for idenfification
          await _gpiop$3.write(this.heartbeatControlChannelId, !ledState);

          await _delay$1(_GARAGE_SYSTEM_IDENTIFICATION_TOGGLE_TIMEOUT);
        }

        // Restart the heartbeat
        this._heartbeatIntervalId = setInterval((() => { this.doHeartbeat(); }), _HEARTBEAT_INTERVAL);
      }

      resolve(this.Initialized);
    });
  }

  /* ========================================================================
  Description: Passthru accessor for the state of the specified door.

  Parameters:  doorName: Name of the door being querried.

  Return:      Door State: 'UNKNOWN', 'OPEN',  or 'CLOSED'
     ======================================================================== */
  GetDoorState(doorName) {
    let doorState = DOOR_STATE.UNKNOWN;

    const door = this._doorControllers.get(doorName);
    if (door != undefined) {
      doorState = door.DoorState;
    }
    return doorState;
  }

  /* ========================================================================
  Description: Passthru accessor to activate the specified door.

  Parameters:  doorName: Name of the door being altered.

  Return:      true if successful.
     ======================================================================== */
  ActivateDoor(doorName) {
    const door = this._doorControllers.get(doorName);
    if (door != undefined) {
      door.ActivateDoor();
    }

    return (door != undefined);
  }

  /* ========================================================================
  Description: Passthru read accessor for the lock state of the specified door.

  Parameters:  doorName: Name of the door being querried.

  Return:      true if locked. false otherwise.
     ======================================================================== */
  GetDoorLocked(doorName) {
    let locked = true;

    const door = this._doorControllers.get(doorName);
    if (door != undefined) {
      locked = door.DoorLocked;
    }
    return locked;
  }

  /* ========================================================================
  Description: Passthru write accessor for the lock state of the specified door.

  Parameters:  doorName: Name of the door being querried.
               locked:   Flag indicating locked state (true if locked)

  Return:      None
     ======================================================================== */
  SetDoorLocked(doorName, locked) {
    const door = this._doorControllers.get(doorName);
    if (door != undefined) {
      door.DoorLocked = locked;
    }
  }

  /* ========================================================================
  Description: Passthru accessor to identify the specified door.

  Parameters:  doorName: Name of the door being identified.

  Return:      true if successful.
     ======================================================================== */
  IdentifyDoor(doorName) {

    // Identify the garage system as well.
    this.Identify();

    const door = this._doorControllers.get(doorName);
    if (door != undefined) {
      door.IdentifyDoor();
    }

    return (door != undefined);
  }

  /* ========================================================================
      Description: Callback for the interval timer used to manage the activity LED

      Parameters:  None

      Return:      None
     ======================================================================== */
  doHeartbeat() {
    // Ensure that the system has completed initialization.
    if (this.Initialized)
    {
      // Toggle the LED state.
      this._heartbeatLEDState = ((LED_STATE.ON === this._heartbeatLEDState) ? LED_STATE.OFF : LED_STATE.ON);
      // Update the LED
      _gpiop$3.write(this.heartbeatControlChannelId, this._heartbeatLEDState);
    }
  }

  /* ========================================================================
      Description: Event handler for door state changes.

      Parameters:  oldState:  State prior to the change notification.
                   newState:  Current state of the door.
                   contect:   Object reference to the DoorController raising the notification.

      Return:      None
     ======================================================================== */
  doorStateChange(oldState, newState, context) {
    // Validate Inputs
    if (context instanceof DoorController) {
      _debug$4(`Door Changed State: Name:${context.Name} oldState=${oldState} newState=${newState}`);

      // Pass this event along.
      this.emit('door_state_change', oldState, newState, context.Name);
    }
  }
}

/* ==========================================================================
   File:        main.js
   Description: Homebridge Platform for controlling the garage system.
   Copyright:   May 2019
   ========================================================================== */

// External dependencies and imports.
const _debug$5        = require('debug')('homebridge-controller');
const PLUGIN_VER    = require('../package.json').version;
const PLUGIN_NAME   = require('../package.json').config_info.plugin;
const PLATFORM_NAME = require('../package.json').config_info.platfrom;

// Accessory must be created from PlatformAccessory Constructor
let _PlatformAccessory  = undefined;
// Service and Characteristic are from hap-nodejs
let _Service            = undefined;
let _Characteristic     = undefined;
let _UUIDGen            = undefined;

/* Default Export Function for integrating with Homebridge */
/* ========================================================================
   Description: Exported default function for Homebridge integration.

   Parameters:  homebridge: reference to the Homebridge API.

   Return:      None
   ======================================================================== */
module.exports.default = (homebridge) => {
  _debug$5(`homebridge API version: v${homebridge.version}`);

  // Accessory must be created from PlatformAccessory Constructor
  _PlatformAccessory  = homebridge.platformAccessory;

  // Service and Characteristic are from hap-nodejs
  _Service            = homebridge.hap.Service;
  _Characteristic     = homebridge.hap.Characteristic;
  _UUIDGen            = homebridge.hap.uuid;

  // For platform plugin to be considered as dynamic platform plugin,
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GrumpyGarageSystemPlatform, true);

};

/* ==========================================================================
   Class:       GrumpyGarageSystemPlatform
   Description: Imnplements Homebridge Platform for the Garage Controller System
   Copyright:   May 2019
   ========================================================================== */
class GrumpyGarageSystemPlatform {
  /* ========================================================================
     Description: Constructor for the homebridge platroem.

     Parameters:  log:    Object for logging in the Homebridge Context
                  config: Object for the platform configuration (from config.json)
                  api:    Object for the Homebridge API.

     Return:      N/A
     ======================================================================== */
  constructor(log, config, api) {

    /* Cache the arguments. */
    this._log     = log;
    this._config  = config;
    this._api     = api;

    console.log(config);

    // Validate the supplied configuration.
    if (!this._config.hasOwnProperty('name')) {
      this._config['name'] = 'Unknown';
    }
    if (!this._config.hasOwnProperty('platform')) {
      this._config['platform'] = 'Unknown';
    }

    /* My local data */
    this._name                  = this._config['name'];
    this._doorControllerNames   = [];
    this._targetDoorState       = _Characteristic.TargetDoorState.CLOSED;

    // Underlying engine
    this._garageController = undefined;

    /* My Services */
    this._lockOutService = undefined;

    this._requestServer = undefined;

    /* Bind Handlers */
    this._bindDoInitialization   = this._doInitialization.bind(this);
    this._bindDestructorNormal   = this._destructor.bind(this, {cleanup:true});
    this._bindDestructorAbnormal = this._destructor.bind(this, {exit:true});
    this._bindDoorStateChange    = this._doorStateChange.bind(this);

    /* Log our creation */
    this._log(`GrumpyGarageSystemPlatform: Creating Platform - ${this._name}`);

    /* Create an empty map for our accessories */
    this._accessories = new Map();

    // Register for the Did Finish Launching event
    this._api.on('didFinishLaunching', this._bindDoInitialization);

    // Register for shutdown events.
    //do something when app is closing
    process.on('exit', this._bindDestructorNormal);
    //catches ctrl+c event
    process.on('SIGINT', this._bindDestructorAbnormal);
    //catches uncaught exceptions
    process.on('uncaughtException', this._bindDestructorAbnormal);
  }

  /* ========================================================================
     Description: Destructor

     Parameters:  options: Object. Typically containing a "cleanup" or "exit" member.
                  err:     The source of the event trigger.

     Return:      None

     Remarks:     Used to clean up at the earliest opportunity when the process exits.
     ======================================================================== */
  async _destructor(options, err) {
    // Is there an indication that the system is either exiting or needs to
    // be cleaned up?
    if ((options.exit) || (options.cleanup)) {
      // Set all of the accessories to unreachable. This will prevent Homekit from
      // making calls on us during cleanup.
      this._accessories.forEach((accessory) => {
        accessory.updateReachability(false);
      });

      // Cleanup the garage controller system.
      if (this._garageController != undefined) {
        _debug$5(`Terminating the garage controller..... Init: ${this._garageController.Initialized}`);
        await this._garageController.Terminate();
        this._garageController = undefined;
      }
    }
  }

  /* ========================================================================
     Description: Configures accessory

     Parameters:  accessory: Homekit accessory being configured

     Return:      Array of services and characteristics.

     Remarks:     Opportunity to initialize the system and publish accessories.
                  Called by the Homebridge Server.
     ======================================================================== */
  configureAccessory(accessory) {
    if (accessory instanceof _PlatformAccessory) {
      this._log(`Configuring Accessory: ${accessory.displayName} UUID: ${accessory.UUID}`);

      // Mark the accessory as not reachable.
      accessory.updateReachability(false);

      // Append the accessory to our list.
      this._accessories.set(accessory.UUID, accessory);
    }
    else {
      throw new Error(`_configureAccessory: Invalid argument.`);
    }
  }

  // Handler will be invoked when user try to config your plugin.
  // Callback can be cached and invoke when necessary.
  /* ========================================================================
     Description: Homekit API handler for configuring an accessory.

     Parameters:  context:  Homekit accessory being configured
                  callback: Callback to provide configuration to be saved.
                            function(response, type, replace, config)
                            set "type" to platform if the plugin is trying to modify platforms section
                            set "replace" to true will let homebridge replace existing config in config.json
                            "config" is the data platform trying to save

     Return:      Array of services and characteristics.

     Remarks:     None.
     ======================================================================== */
  configurationRequestHandler(context, request, callback)
  {
    this._log("Context: ", JSON.stringify(context));
    this._log("Request: ", JSON.stringify(request));

    // Check the request response
    if (request && request.response && request.response.inputs && request.response.inputs.name)
    {
      this._addAccessory(request.response.inputs.name);

      // Invoke callback with config will let homebridge save the new config into config.json
      // Callback = function(response, type, replace, config)
      // set "type" to platform if the plugin is trying to modify platforms section
      // set "replace" to true will let homebridge replace existing config in config.json
      // "config" is the data platform trying to save
      callback(null, "platform", true, {"platform":PLATFORM_NAME, "otherConfig":"SomeData"});
      return;
    }
  }

  /* ========================================================================
     Description: Event handler when the system has loaded the platform.

     Parameters:  None

     Return:      N/A

     Remarks:     Opportunity to initialize the system and publish accessories.
     ======================================================================== */
  async _doInitialization() {

    this._log(`Homebridge Plug-In ${this._name} has finished launching.`);

    let sys_config = undefined;
    if (this._config.hasOwnProperty('system')) {
      // Get the system configuration,
      sys_config = this._config.system;
    }

    // Create & Start the garage controller system.
    this._garageController = new GarageSystem();
    const initialized = await this._garageController.Start(sys_config);
    if (initialized) {
      // Register for Garage Controller events of interest.
      this._garageController.on( 'door_state_change', this._bindDoorStateChange);

      // Get the list of names of the garage door controllers.
      this._doorControllerNames = this._garageController.DoorControllers;
      this._log(`Door Controllers: (${this._doorControllerNames.length}) Data:(${this._doorControllerNames})`);

      // Create my default accessories.
      // ===============================================
      const accessoryMake = 'Grumpy Dev';

      // System Accessories
      // =======================================================================

      // 'Door' specific accessories.
      // =======================================================================
      this._doorControllerNames.forEach((doorName) => {

        // Create and manage the Garage Door accessory
        this._doInitializeGarageDoorAccessory(accessoryMake, doorName);
      });

      /* Clean up any accessories that are no longer supported. */
      const removedAccessories = [];
      this._accessories.forEach((accessory) => {
        // If an accessory exists but is no longer supported, then it will have
        // been restored, but not 'managed' when setting events, etc. As a result,
        // the 'context'  will be at the default value, which is an empty array.
        if (!accessory.reachable) {
          // Append this accessory to the 'deleted' list.
          removedAccessories.push(accessory);

          // Remove this item from the list.
          this._accessories.delete(accessory);
        }
      });
      // Finally, remove the accessories from Homebridge.
      if (removedAccessories.length > 0) {
        this._removeAccessories(removedAccessories);
      }
    }
    else {
      this._log(`Error: Garage System Failed to Initialize !!`);
    }
  }

  /* ========================================================================
   Description:    Helper to add an accessory

   Parameters:     candidateAccessory: Accessory to be added

   Return:         Actual accessory.

   Remarks:        The candidate accessory nay be replaced by one that already exists from prior sessions.
   ======================================================================== */
  _addAccessory(candidateAccessory) {
    let newAccessory = false;

    if (candidateAccessory instanceof _PlatformAccessory) {

      newAccessory = !this._accessories.has(candidateAccessory.UUID);

      // Is the accessory already registered?
      if (!newAccessory) {
        // Accessory already exists. Update it.
        const accessory = this._accessories.get(candidateAccessory.UUID);
        const service = accessory.getService(_Service.AccessoryInformation);

        // Copy the context from the candidate accessory. This has data that is
        // needed for handling events.
        accessory.context = candidateAccessory.context;

        // Manage the Manufacturer characteristic.
        if (service.testCharacteristic(_Characteristic.Manufacturer)) {
          // Update the Manufacturer characteristic
          service.updateCharacteristic(_Characteristic.Manufacturer, candidateAccessory.context.make);
        }
        else {
          // Create the Manufacturer characteristic
          service.setCharacteristic(_Characteristic.Manufacturer, candidateAccessory.context.make);
        }
        // Manage the Model characteristic.
        if (service.testCharacteristic(_Characteristic.Model)) {
          // Update the Model characteristic
          service.updateCharacteristic(_Characteristic.Model, candidateAccessory.context.model);
        }
        else {
          // Create the Model characteristic
          service.setCharacteristic(_Characteristic.Model, candidateAccessory.context.model);
        }
        // Manage the FirmwareRevision characteristic.
        if (service.testCharacteristic(_Characteristic.FirmwareRevision)) {
          // Update the FirmwareRevision characteristic
          service.updateCharacteristic(_Characteristic.FirmwareRevision, candidateAccessory.context.fwRev);
        }
        else {
          // Create the FirmwareRevision characteristic
          service.setCharacteristic(_Characteristic.FirmwareRevision, candidateAccessory.context.fwRev);
        }
        // Manage the SerialNumber characteristic.
        if (service.testCharacteristic(_Characteristic.SerialNumber)) {
          // Update the SerialNumber characteristic
          service.updateCharacteristic(_Characteristic.SerialNumber, candidateAccessory.context.serialNum);
        }
        else {
          // Create the SerialNumber characteristic
          service.setCharacteristic(_Characteristic.SerialNumber, candidateAccessory.context.serialNum);
        }

        // Ensure that the configured service exists.
        const defaultService = accessory.getService(accessory.context.type);
        if (!defaultService) {
          this._log(`_addAccessory: Adding Service:${accessory.context.type} (${accessory.context.key})`);
          accessory.addService(accessory.context.type, accessory.context.key);
        }

        // Update the reachability
        accessory.updateReachability(true);
      }
      else {
        // Accessory is new. Create from scratch.
        this._log(`_addAccessory: Adding new accessory (${candidateAccessory.context.name})`);
        candidateAccessory.getService(_Service.AccessoryInformation)
            .setCharacteristic(_Characteristic.Manufacturer,     candidateAccessory.context.make)
            .setCharacteristic(_Characteristic.Model,            candidateAccessory.context.model)
            .setCharacteristic(_Characteristic.FirmwareRevision, candidateAccessory.context.fwRev)
            .setCharacteristic(_Characteristic.SerialNumber,     candidateAccessory.context.serialNum);

        candidateAccessory.addService(candidateAccessory.context.type, candidateAccessory.context.name);

        // Update the reachability
        candidateAccessory.updateReachability(true);

      }
    }
    else {
      throw new Error(`_addAccessory: Invalid argument.`);
    }

    return newAccessory;
  }

  /* ========================================================================
     Description: Removes the specified platform accessories.

     Parameters:  accessories: An array of accessories to be removed.

     Return:      None.
     ======================================================================== */
  _removeAccessories(accessories) {
    this._log(`Removing Accessories.`);

    // Check for the presence of accessories.
    if (accessories.length > 0) {
      // Unregister the accessories.
      this._api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    }
  }

  /* ========================================================================
     Description: Homebridge accessor to identify the Door Accessory.

     Parameters:  options:  Context. Object with 'key' field that is the name of the door being sought
                  paird:    Flag (boolean) indicating that this accessory is already paired.
                  callback: Function to be invoked upon completion.

     Return:      None.
     ======================================================================== */
  _identifyDoorAccessory(options, paired, callback) {
    let err = null;
    if (options.hasOwnProperty('key')) {
      // Get the name of the door.
      const name = options.key;

      // Attempt to identify the door.
      if (!this._garageController.IdentifyDoor(name)) {
        // Failed to identify.
        err = new Error(`Unable to identify door '${name}'`);
      }
    }
    else {
      err = new Error(`Unable to identify door accessory.`);
      this._log(`_identifyDoorAccessory: Unexpected value for 'options': ${JSON.stringify(options)}`);
    }

    // return status
    callback(err);
  }

  /* ========================================================================
   Description:    Homebridge event handler for service configuration changes

   Parameters:     options: Context. Object with 'key' field that is the name of the door accessory service being changed.
                   service: Service being changed.

   Return:         None
   ======================================================================== */
  _configureChangeDoorAccessory(options, service) {
    if (options.hasOwnProperty('key')) {
      // Get the name of the door.
      const name = options.key;
      this._log(`_configureChangeDoorAccessory: configuration changed for ': ${name}\n${JSON.stringify(service)}`);
    }
  }

  /* ========================================================================
     Description: Homebridge accessor to get the Current Door State.

     Parameters:  options:  Context. Object with 'key' field that is the name of the door being sought
                  callback: Function to be invoked upon completion. (includes data being sought)

     Return:      None.
     ======================================================================== */
  _getCurrentDoorState(options, callback) {
     let doorCharacteristicVal = _Characteristic.CurrentDoorState.STOPPED;

     if (options.hasOwnProperty('key')) {
       // Get the name of the door.
       const name = options.key;

       /* Log to the console the value whenever this function is called */
       _debug$5(`calling _getCurrentDoorState: ${name}`);

       // Get the state for the door and update the accessory.
       const doorState = this._garageController.GetDoorState(name);
       // Translate the state into a characteristic value.
       doorCharacteristicVal = ((doorState === 'OPEN') ? _Characteristic.CurrentDoorState.OPEN : _Characteristic.CurrentDoorState.CLOSED);

     }
     else {
       this._log(`_getCurrentDoorState: Unexpected value for 'options': ${JSON.stringify(options)}`);
     }

     callback(null, doorCharacteristicVal);
  }

  /* ========================================================================
     Description: Homebridge accessor to change the Target Door State.

     Parameters:  options:   Object with 'key' field that is the name of the door being sought
                  stateData: Object with 'oldValue', 'newValue', and 'context' fields.

     Return:      None.
     ======================================================================== */
  _changeTargetDoorState(options, stateData) {
    /*
     * this is called when HomeKit is notifying clients of a change to the current state of the characteristic as defined in our getServices() function
     */

     if (options.hasOwnProperty('key')) {
       // Get the name of the door.
       const name = options.key;

       /* Log to the console the value whenever this function is called */
       _debug$5(`calling _changeTargetDoorState: ${name}`);

       // Cache the new value.
       if (stateData.hasOwnProperty('newValue')) {
         this._targetDoorState = stateData.newValue;
       }
       else {
         throw new Error(`stateData missing newValue: ${JSON.stringify(stateData)}`);
       }

       // Get the state for the door and update the accessory.
       const doorState = this._garageController.GetDoorState(name);
       // Translate the state into a characteristic value.
       const currentDoorState = ((doorState === 'OPEN') ? _Characteristic.TargetDoorState.OPEN : _Characteristic.TargetDoorState.CLOSED);

       if (stateData.hasOwnProperty('oldValue')) {
         if (stateData.oldValue === currentDoorState)
         {
           // Desire changing state, so Activate the door.
           this._garageController.ActivateDoor(name);
         }
         else {
           this._log(`Door (${name}) is already in the desired state: (${this._targetDoorState})`);
         }
       }
     }
     else {
       this._log(`_changeTargetDoorState: Unexpected value for 'options': ${JSON.stringify(options)}`);
     }
  }

  /* ========================================================================
     Description: Homebridge accessor to set the Target Door State.

     Parameters:  options:   Object with 'key' field that is the name of the door being sought
                  newValue:  Proposed new value for the Door State.
                  callback:  Function to be invoked upon completion. (includes error, if any)

     Return:      None.
     ======================================================================== */
  _validateTargetDoorStateChange(options, newValue, callback){
    let error = null;

    if (options.hasOwnProperty('key')) {

      // Get the name of the door.
      const name = options.key;

      /* Log to the console the value whenever this function is called */
      this._log(`calling _validateTargetDoorStateChange: ${name}`);

      // If the lock is not unsecured and the target door state is changing to a value that is different than the current door state, issue an error.
      // Get the state for the door and update the accessory.
      const doorState   = this._garageController.GetDoorState(name);
      const doorLocked  = this._garageController.GetDoorLocked(name);

      // Translate the state into a characteristic values.
      const allowableTargetDoorCharacteristicVal   = ((doorState === 'OPEN') ? _Characteristic.TargetDoorState.OPEN : _Characteristic.TargetDoorState.CLOSED);

      if ((doorLocked === true) &&
          (newValue !== this._targetDoorState) &&
          (newValue !== allowableTargetDoorCharacteristicVal)) {
        // Lock is not unsecured.
        error = new Error(`lock is not unsecured`);
        _debug$5(`_validateTargetDoorStateChange: ${name} Lock is not unsecured (${doorLocked})`);
      }

      // Was an error encountered?
      if (error != null) {
        // Yes. Reset the target door state.
        const charTargetDoorState = this._findCharacteristic(name, _Service.GarageDoorOpener, _Characteristic.TargetDoorState);
        if (charTargetDoorState instanceof _Characteristic) {
          // Reset to the cached value, but do so asynchronously.
          setTimeout((resetVal, characteristic) => {
            _debug$5(`_validateTargetDoorStateChange: resetting target door state to (${resetVal})`);
            characteristic.updateValue(resetVal);
          }, 10, this._targetDoorState, charTargetDoorState);
        }
      }
    }
    else {
      error = new Error(`options did not include a key`);
      this._log(`_validateTargetDoorStateChange: Unexpected value for 'options': ${JSON.stringify(options)}`);
    }

    callback(error);
  }

  /* ========================================================================
     Description: Homebridge accessor to change the Target Lock State.

     Parameters:  options:   Object with 'key' field that is the name of the door being sought
                  stateData: Object with 'oldValue', 'newValue', and 'context' fields.

     Return:      None.
     ======================================================================== */
  _changeTargetLockState(options, stateData) {
    /*
     * this is called when HomeKit is notifying clients of a change to the current state of the characteristic as defined in our getServices() function
     */
     if (options.hasOwnProperty('key')) {
        // Get the name of the door.
        const name = options.key;

        /* Log to the console the value whenever this function is called */
        this._log(`calling _changeTargetLockState: ${name}`);

        // This is a software lock, so just sync the new value to the 'Current Lock State'
        const charCurrentLockState = this._findCharacteristic(name, _Service.GarageDoorOpener, _Characteristic.LockCurrentState);
        if ((charCurrentLockState instanceof _Characteristic) &&
            (stateData.hasOwnProperty('newValue'))) {
           // Propagate the value
           const newCurrentLockState = ((_Characteristic.LockTargetState.UNSECURED === stateData.newValue) ? _Characteristic.LockCurrentState.UNSECURED : _Characteristic.LockCurrentState.SECURED);
           charCurrentLockState.setValue(newCurrentLockState);
        }
     }
     else {
        this._log(`_changeTargetLockState: Unexpected value for 'options': ${JSON.stringify(options)}`);
     }
  }

  /* ========================================================================
     Description: Homebridge accessor to change the Current Lock State.

     Parameters:  options:   Object with 'key' field that is the name of the door being sought
                  stateData: Object with 'oldValue', 'newValue', and 'context' fields.

     Return:      None.
     ======================================================================== */
  _changeCurrentLockState(options, stateData) {
    /*
     * this is called when HomeKit is notifying clients of a change to the current state of the characteristic as defined in our getServices() function
     */
     if (options.hasOwnProperty('key')) {
       // Get the name of the door.
       const name = options.key;

       /* Log to the console the value whenever this function is called */
       this._log(`calling _changeCurrentLockState: ${name}`);

       // Set the lock state for the door specified.
       if (stateData.hasOwnProperty('newValue')) {
         const locked = ((_Characteristic.LockCurrentState.UNSECURED === stateData.newValue) ? false : true);
         this._garageController.SetDoorLocked(name, locked);
       }
       else {
         this._log(`_changeCurrentLockState: Unexpected value for 'stateData': ${JSON.stringify(stateData)}`);
       }
     }
     else {
       this._log(`_changeCurrentLockState: Unexpected value for 'options': ${JSON.stringify(options)}`);
     }
  }

  /* ========================================================================
      Description: Event handler for door state changes.

      Parameters:  oldState:  State prior to the change notification.
                   newState:  Current state of the door.
                   contect:   Name of the door changing state.

      Return:      None
     ======================================================================== */
  _doorStateChange(oldState, newState, context) {
    this._log(`Door '${context}' has changed from ${oldState} to ${newState}`);

    // Get the state for the door and update the accessory.
    const doorState = this._garageController.GetDoorState(context);
    // Translate the state into a characteristic values.
    let currDoorCharacteristicVal = _Characteristic.CurrentDoorState.STOPPED;
    switch (doorState) {
      case 'OPENING':
      {
        // Door is opening.
        currDoorCharacteristicVal = _Characteristic.CurrentDoorState.OPENING;
      }
      break;

      case 'OPEN':
      {
        // Door is open.
        currDoorCharacteristicVal = _Characteristic.CurrentDoorState.OPEN;
      }
      break;

      case 'CLOSING':
      {
        // Door is closing.
        currDoorCharacteristicVal = _Characteristic.CurrentDoorState.CLOSING;
      }
      break;

      case 'CLOSED':
      {
        // Door is closed.
        currDoorCharacteristicVal = _Characteristic.CurrentDoorState.CLOSED;
      }
      break;

      case 'UNKNOWN':
      // Break intentionally missing
      default:
      {
        // Not good !!
        currDoorCharacteristicVal = _Characteristic.CurrentDoorState.STOPPED;
      }
      break;
    }

    const targetDoorCharacteristicVal = ((doorState === 'OPEN') ? _Characteristic.TargetDoorState.OPEN  : _Characteristic.TargetDoorState.CLOSED);

    // Find the characteristic to publish the updated value.
    const charCurrentDoorState = this._findCharacteristic(context, _Service.GarageDoorOpener, _Characteristic.CurrentDoorState);
    if (charCurrentDoorState instanceof _Characteristic) {
      // Publish updated value.
      this._log(`Publish new state for door '${context}': ${currDoorCharacteristicVal}`);
      charCurrentDoorState.setValue(currDoorCharacteristicVal);

      // Also sync this value to the target door state. Recall, the door can be opened from means other than the app.
      const charTargetDoorState = this._findCharacteristic(context, _Service.GarageDoorOpener, _Characteristic.TargetDoorState);
      if (charTargetDoorState instanceof _Characteristic) {
        charTargetDoorState.setValue(targetDoorCharacteristicVal);
      }
    }
  }

  /* ========================================================================
      Description: Helper to configure and setup the Garage Door accessory,
                   services and charachteristics.

      Parameters:  accessoryMake: Name to use for the accessory make.
                   doorName:      Name of the door. Intended to be unique.

      Return:      None
     ======================================================================== */
  _doInitializeGarageDoorAccessory(accessoryMake, doorName) {
    // Lockout accessory.
    const nameDoorControl = `${doorName} Control`;
    const doorAccessory = new _PlatformAccessory(nameDoorControl, _UUIDGen.generate(nameDoorControl));

    // Configure the default accessory.
    doorAccessory.context.name       = nameDoorControl;
    doorAccessory.context.make       = accessoryMake;
    doorAccessory.context.model      = 'Door Control';
    doorAccessory.context.fwRev      = `${PLUGIN_VER}`;
    doorAccessory.context.serialNum  = '0000001';
    doorAccessory.context.type       = _Service.GarageDoorOpener;
    doorAccessory.context.key        = doorName;

    // Add/Update the accessory.
    if (this._addAccessory(doorAccessory))
    {
      // This is a new accessory.

      // Append the accessory to the map keyed on the UUID.
      this._accessories.set(doorAccessory.UUID, doorAccessory);

      // Register this 'new' accessory
      this._api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [doorAccessory]);
    }

    // Get the accessory that is in-play.
    const theAccessory = this._accessories.get(doorAccessory.UUID);
    if (theAccessory) {

      // Register for identification
      theAccessory.on('identify', this._identifyDoorAccessory.bind(this, {key:doorName}));
      // Register for configuration changes
      theAccessory.on('service-configurationChange', this._configureChangeDoorAccessory.bind(this, {key:doorName}));

      // Register for the events.
      const doorService =theAccessory.getService(doorAccessory.context.type);
      if (doorService) {
        /* Name characteristic (optional) */
        const tmpNameChar = new _Characteristic.Name;
        if (doorService.testCharacteristic(tmpNameChar.displayName)) {
          const nameCharacteristic = doorService.getCharacteristic(_Characteristic.Name);

          // Set the name of the door.
          nameCharacteristic.updateValue(doorName);
        }
        else {
          this._log(`Unable to get GarageDoorOpener 'Name' characteristic !!`);
        }

        /* Target Lock State (Optional) */
        const targetLockStateCharateristic = doorService.getCharacteristic(_Characteristic.LockTargetState);
        // Register for the 'change'
        targetLockStateCharateristic.on('change', this._changeTargetLockState.bind(this, {key:doorName}));
        // Ensure that the target lock state always defaults to 'locked'
        targetLockStateCharateristic.updateValue(_Characteristic.LockTargetState.SECURED);

        /* Current Lock State (Optional) */
        const currentLockStateCharacteristic = doorService.getCharacteristic(_Characteristic.LockCurrentState);
        // Register for the 'change'. Needed to track/cache the current lock state.
        currentLockStateCharacteristic.on('change', this._changeCurrentLockState.bind(this, {key:doorName}));
        // Ensure that the current lock state always defaults to 'locked'
        const currentLockedVal = (this._garageController.GetDoorLocked(doorName) ? _Characteristic.LockCurrentState.SECURED : _Characteristic.LockCurrentState.UNSECURED);
        currentLockStateCharacteristic.updateValue(currentLockedVal);
        currentLockStateCharacteristic.updateValue(_Characteristic.LockCurrentState.SECURED);

        /* Current Door State characteristic */
        const tmpCurrDoorChar = new _Characteristic.CurrentDoorState;
        if (doorService.testCharacteristic(tmpCurrDoorChar.displayName)) {
          const currentDoorStateCharacteristic = doorService.getCharacteristic(_Characteristic.CurrentDoorState);

          // Register for the 'get' event handler.
          currentDoorStateCharacteristic.on('get', this._getCurrentDoorState.bind(this, {key:doorName}));

          // Get the state for the door and update the accessory.
          const doorState = this._garageController.GetDoorState(doorName);
          // Translate the state into a characteristic value.
          const doorCharacteristicVal = ((doorState === 'OPEN') ? _Characteristic.CurrentDoorState.OPEN : _Characteristic.CurrentDoorState.CLOSED);
          // Publish.
          currentDoorStateCharacteristic.updateValue(doorCharacteristicVal);
        }
        else {
          this._log(`Unable to get GarageDoorOpener 'CurrentDoorState' characteristic !!`);
        }

        /* Target Door State characteristic */
        const tmpTargetDoorChar = new _Characteristic.TargetDoorState;
        if (doorService.testCharacteristic(tmpTargetDoorChar.displayName)) {
          const targetDoorStateCharacteristic = doorService.getCharacteristic(_Characteristic.TargetDoorState);

          // Register for the 'set'. Needed to validate the request is allowed (Lock is unsecured)
          targetDoorStateCharacteristic.on('set', this._validateTargetDoorStateChange.bind(this, {key:doorName}));

          // Register for the 'change'
          targetDoorStateCharacteristic.on('change', this._changeTargetDoorState.bind(this, {key:doorName}));

          // Get the state for the door and update the accessory.
          const doorState = this._garageController.GetDoorState(doorName);
          // Translate the state into a characteristic value.
          const doorCharacteristicVal = ((doorState === 'OPEN') ? _Characteristic.TargetDoorState.OPEN : _Characteristic.TargetDoorState.CLOSED);
          // Publish, ensuring that there is a state change to get initialized.
          targetDoorStateCharacteristic.updateValue(this._targetDoorState);
          targetDoorStateCharacteristic.updateValue(doorCharacteristicVal);
        }

        /* Obstruction Detected characteristic */
        const tmpObstructionDetectedChar = new _Characteristic.ObstructionDetected;
        if (doorService.testCharacteristic(tmpObstructionDetectedChar.displayName)) {
          const obstructionDetectedCharacteristic = doorService.getCharacteristic(_Characteristic.ObstructionDetected);

          // The Obstruction Detected characteristic is required and removing it causes the plugin to fail to show up on the Home app.
          // Just make the the characteristic hidden.
          if (obstructionDetectedCharacteristic.hasOwnProperty('props')) {
            const props = obstructionDetectedCharacteristic.props;
            if (props.hasOwnProperty('perms')) {
              const perms = props.perms;
              if ((Array.isArray(perms)) &&
                  (!perms.includes(_Characteristic.Perms.HIDDEN))) {
                // Append the Hidden permission
                perms.push(_Characteristic.Perms.HIDDEN);
                // Update the permissions
                obstructionDetectedCharacteristic.setProps({perms:perms});
              }
            }
          }
        }
      }
      else {
        this._log(`Unable to get GarageDoorOpener service !!`);
      }
    }
    else {
      this._log(`Unable to get the door accessory: ${doorAccessory.context.name}!!`);
    }
  }

  /* ========================================================================
      Description: Helper to retrieve the specified characteristic.

      Parameters:  accessoryKey:            Key used to identify the accessory of interest. (Assumed to match the Accessory.context.key)
                   serviceTemplate:         Template of the service being sought.
                   characteristicTemplate:  Template of the characteristic being sought.

      Return:      Characteristic if match found. Otherwise undefined.
     ======================================================================== */
  _findCharacteristic(accessoryKey, serviceTemplate, characteristicTemplate) {
    let matchedCharacteristic = undefined;

    // Get a iterable list of Accessories
    const iterAccessories = this._accessories.values();
    for (let accessory of iterAccessories) {
      if ((accessory.context.hasOwnProperty('key')) &&
          (accessoryKey === accessory.context.key)) {
         const service = accessory.getService(serviceTemplate);
         // Is this a matching service?
         if (service != undefined) {
           // Is there a matching characteristic?
           if (service.testCharacteristic(characteristicTemplate)) {
              // Match found.
              matchedCharacteristic = service.getCharacteristic(characteristicTemplate);
              break;
           }
         }
      }
    }

    return matchedCharacteristic;
  }
}

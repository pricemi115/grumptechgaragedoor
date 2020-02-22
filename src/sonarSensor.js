/* ==========================================================================
   File:               sonarSensor.js
   Class:              SonarSensor
   Description:	       Provide status and control of a sonar sensor used for
                       detection.
   Copyright:          Jun 2019
   ========================================================================== */
'use strict';

// External dependencies and imports.
const _gpio       = require('../node_modules/rpi-gpio');
const _gpiop      = _gpio.promise;
const _debug      = require('debug')('sonarSensor');

// Internal dependencies
import _sensorBase, * as modSensorBase from './sensorBase.js';

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
class SonarSensor extends _sensorBase {
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

    _debug(`Constructing sonar sensor`);

    // Verify that the configuration is valid. Throws an exception if false.
    SonarSensor.ValidateConfiguration(configuration);

    // Consume configuration
    /* Polling interval is optional. */
    this._sonarPingInterval = (configuration.hasOwnProperty('polling_interval') ? configuration.polling_interval : _DEFAULT_SONAR_POLLING_INTERVAL) * 1000.0/* milliseconds / second */;
    /* Distance threshold change notification is optional */
    this._distanceThreshold = (configuration.hasOwnProperty('polling_interval') ? configuration.distance_threshold_change_notification : _DISTANCE_THRESHOLD_FOR_CHANGE_NOTIFICATION);
    this._gpioTriggerOut    = configuration.trigger_out;
    this._gpioEchoIn        = configuration.echo_in;
    this._detectMin         = configuration.detect_threshold_min;
    this._detectMax         = configuration.detect_threshold_max;

    // Other data members
    this._initialize();

    /* Create a function pointer for state change notifications. */
    this._myStateChangeCB   = this._stateChange.bind(this);

    _debug(`New Sonar Sensor: id=${this.Identifier}`);
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

    _debug(`Terminating Sonar Sensor: ${this.Identifier}`);

    // Stop the sonar.
    this.Active = false;

    // Unregister for change notifications
    _gpio.off( 'change', this._myStateChangeCB );

    super._initialized = false;
  }

  /* ========================================================================
     Description: Start/Initialize the sonar sensor.

     Parameters:  None

     Return:      Flag indicating if the sensor has been initialized.
     ======================================================================== */
  async Start() {

    _debug(`Starting Sonar: ${this.Identifier}`);

    // Re-initialize the internal data.
    this._initialize();

    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the sonar trigger and initialize to LOW */
                       _gpiop.setup(this._gpioTriggerOut, _gpio.DIR_LOW),
                       /* Configure the door sonar echo input channel to detect all events to allow
                          for the measurement of the pulse duration, which equates to distance. */
                       _gpiop.setup(this._gpioEchoIn,     _gpio.DIR_IN,  _gpio.EDGE_BOTH),
                      ])
    .then(async (setupResults) => {
      // Register for state change events for all input channels.
      _gpio.on( 'change', this._myStateChangeCB );

      // Start the sonar measuring system.
      this.Active = true;

      // Indicate that the sonar is now initialized and ready to operate.
      super._initialized = true;
    })
    .catch((err) => {
      _debug(`Init Error(Sonar:${this.Identifier}): ${err.toString()}`);
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
      _debug(`Sonar ${this.Identifier}: Sonar is already ${active ? 'active' : 'inactive'}`);
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
      _debug(`Sonar (${this.Identifier}) Unexpected trigger request.`);
    }
    try {
      // Trigger the sonar.
      _gpiop.write(this._gpioTriggerOut, ACTIVATE_SONAR)
      .then(() => {
        // Once active, deactivate the sonar after a brief period.
        return setTimeout(_gpiop.write, _SONAR_TRIGGER_TIME, this._gpioTriggerOut, !ACTIVATE_SONAR);
      })
      .then(() => {
        // Set the Sonar State to armed.
        this._sonarState = _SONAR_STATE.ARMED;
      })
      .catch((error) => {
        this.Active = false;
        _debug(`Sonar (${this.Identifier}) Request Error: ${error.toString()}`);
      });
    }
    catch (err) {
      this.Active = false;
      _debug(`Failed to trigger Sonar (${this.Identifier}): (${err})`);
    }
    finally {
      // Restart the sonar if it deactivated due to an error.
      if (!this.Active) {
        _debug(`Sonar (${this.Identifier}) Restart sonar`);
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
                _debug(`Sonar (${this.Identifier}): Object too close. Forcing measurement distance of half of the detectable minimum.`);

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
                _debug(`Sonar (${this.Identifier}): Unexpected GPIO Signal when Pending.`);
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
          _debug(`Sonar (${this.Identifier}): Unexpected GPIO Signal when Not Active.`);
        }
      }
      break;

      default:
      {
        _debug(`Sonar (${this.Identifier}): Unhandled State Change: Chan:${channel} Val:${value}`);
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
                        (this._lastDistanceReading <= this._detectMax)) ? modSensorBase.SENSOR_RESULT.DETECTED : modSensorBase.SENSOR_RESULT.UNDETECTED);
    _debug(`Sonar (${this.Identifier}): Measured Distance=${this._lastDistanceReading} Result=${newResult}`);

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
                          (!configuration.hasOwnProperty('distance_threshold_change_notification')  ||  (typeof(configuration.distance_threshold_change_notification)  === 'number'))                                                                           && /* Optional configuration item */
                          ( configuration.hasOwnProperty('trigger_out')                             &&  (typeof(configuration.trigger_out)                             === 'number'))                                                                           &&
                          ( configuration.hasOwnProperty('echo_in')                                 &&  (typeof(configuration.echo_in)                                 === 'number'))                                                                           &&
                          ( configuration.hasOwnProperty('detect_threshold_min')                    &&  (typeof(configuration.detect_threshold_min)                    === 'number'))                                                                           &&
                          ( configuration.hasOwnProperty('detect_threshold_max')                    &&  (typeof(configuration.detect_threshold_max)                    === 'number'))                                                                           &&
                          (configuration.detect_threshold_max > configuration.detect_threshold_min)                                                                                                                                                               );

    if (!configValid) {
      _debug(`SonarSensor invalid configuration. configuration:${JSON.stringify(configuration)}`);
    }

    return configValid;
  }
}

export default SonarSensor;

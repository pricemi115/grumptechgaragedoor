/* ==========================================================================
   File:               sensorBase.js
   Class:              SensorBase
   Description:	       Provide common status and control of detection sensors.
   Copyright:          Jun 2019
   ========================================================================== */
'use strict';

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

export {SensorBase as default, SENSOR_RESULT};

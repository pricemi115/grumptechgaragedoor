/* ==========================================================================
   File:        garageSystem.js
   Class:       Garage Controller System
   Description: Provides command and control of multiple garage doors,
                temerature, etc. via Raspberry PI GPIO.
   Copyright:   May 2019
   ========================================================================== */
'use strict';

// External dependencies and imports.
const _debug  = require('debug')('garageSystem');
const _gpio   = require('rpi-gpio');
import { EventEmitter } from 'events';
const _gpiop  = _gpio.promise;

// Internal dependencies
import _doorController, * as modDoorCntrl from './doorCntrl.js';

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
const _DEFAULT_HEARTBEAT_CTRL_BCM  = 4/*GPIO4, assuming BCM Mode */;
const _DEFAULT_HEARTBEAT_CTRL_RPI  = 7/*GPIO4, assuming RPI Mode */;

/* ========================================================================
   Description: Helper function to perform a delay

   Parameters:  timeout:  Delay in milliseconds.

   Return:      Promise.

   Remarks:     Assumed to be executed via async/await.
   ======================================================================== */
const _delay = timeout => new Promise( resolveDelay => { setTimeout(resolveDelay, timeout); });

/* GarageSystem represents a garage control system configured, monitored,
   and controlled by a RaspberryPi.

   @event 'door_state_change' => function(oldState, newState, context) {}
          Emitted when the door changes its open/closed states.
          Context will be the name of the door raising the event.
*/
class GarageSystem extends EventEmitter {
  /* ========================================================================
     Description: Constructor for an instance of a garage control system.

     Parameters:  None

     Return:      N/A
     ======================================================================== */
  constructor() {
    _debug('Creating Garage Door Control System.');

    // Initialize the base class.
    super();

    // Initialize members.
    this._heartbeatLEDState   = LED_STATE.OFF;
    this._myDoor              = undefined;
    this._initialized         = false;
    this._doorControllers     = new Map();
    this._heartbeatIntervalId = undefined;

    // Configuration members.
    this.heartbeatControlChannelId = _DEFAULT_HEARTBEAT_CTRL_BCM;

    /* Create a function pointer for state change notifications. */
    this._bindDoorStateChange  = this.doorStateChange.bind(this);
  }

  /* ========================================================================
     Description: Desctuctor for an instance of a garage door control system.

     Parameters:  None

     Return:      None.
     ======================================================================== */
  async Terminate() {

    _debug('Terminating Garage Door Control System.');

    /* Clean up the doors */
    this._doorControllers.forEach(async (door) => {
      _debug(`Killing door: ${door.Name}`);
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
    await _gpiop.write(this.heartbeatControlChannelId, LED_STATE.OFF)
    .then (() => {
      /* Do Nothing. Synchronous operation. */
    });

    /* Clean up the GPIO resources. */
    try {
      _gpio.reset();
    }
    catch(error) {
      _debug(`Error when resetting gpio: (${error.toString()})`);
    }
    finally {
      await _gpiop.destroy()
      .then (() => {
        /* Do Nothing. Synchronous operation. */
      })
      .catch ((error) => {
        _debug(`Error when destroying gpio: (${error.toString()})`);
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

    _debug('Starting Garage Door Control System.');

    // Validate the configuration provided.
    let gpioMode = _gpio.MODE_BCM;  // Default to BCM Mode
    if (config.hasOwnProperty('gpio_mode')) {
      // Get the GPIO mode from the configuration. {Optional}
      switch (config.gpio_mode) {
        case 'BCM':
        {
          gpioMode = _gpio.MODE_BCM;
          // Update the default heartbeat channel assignment
          this.heartbeatControlChannelId =_DEFAULT_HEARTBEAT_CTRL_BCM;
        }
        break;

        case 'RPI':
        {
          gpioMode = _gpio.MODE_RPI;
          // Update the default heartbeat channel assignment
          this.heartbeatControlChannelId =_DEFAULT_HEARTBEAT_CTRL_RPI;
        }
        break;

        default:
        {
          // Use the default.
          _debug(`GarageSystem: Invalid setting for 'gpio_mode' configuration ${config.gpio_mode}`);
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
        _debug(`GarageSystem: Invalid door configuration. doors:${JSON.stringify(config)}`);
      }
    }

    // Initialize the hardware.
    _gpio.setMode(gpioMode);
    // Create an array of promises to configure the GPIO and wait for all of them
    // to complete.
    await Promise.all([/* Configure the heartbeat channel */
                       _gpiop.setup(this.heartbeatControlChannelId, _gpio.DIR_LOW)])
      .then(async (setupResults) => {
          const result = await Promise.all([/* Initialize the heartbeat LED state */
                                            _gpiop.write(this.heartbeatControlChannelId, this._heartbeatLEDState)]);
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
            const newDoor = new _doorController(doorConfig);

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
              _debug('Init Error (Garage System waiting for doors): ', err.toString());
          });
      })
      .catch((err) => {
          _debug('Init Error (Garage System): ', err.toString());
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
          const ledState = await _gpiop.read(this.heartbeatControlChannelId);

          // Update the Door Status LED for idenfification
          await _gpiop.write(this.heartbeatControlChannelId, !ledState);

          await _delay(_GARAGE_SYSTEM_IDENTIFICATION_TOGGLE_TIMEOUT);
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
    let doorState = modDoorCntrl.DOOR_STATE.UNKNOWN;

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
      _gpiop.write(this.heartbeatControlChannelId, this._heartbeatLEDState);
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
    if (context instanceof _doorController) {
      _debug(`Door Changed State: Name:${context.Name} oldState=${oldState} newState=${newState}`);

      // Pass this event along.
      this.emit('door_state_change', oldState, newState, context.Name);
    }
  }
}

export default GarageSystem;

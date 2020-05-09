/* ==========================================================================
   File:        main.js
   Description: Homebridge Platform for controlling the garage system.
   Copyright:   May 2019
   ========================================================================== */
'use strict';

// External dependencies and imports.
const _debug = require('debug')('homebridge-controller');
import { version as PLUGIN_VER }      from '../package.json';
import { config_info as CONFIG_INFO } from '../package.json';

// Internal dependencies
import _garageSystem from './garageSystem.js';

// Configuration constants.
const PLUGIN_NAME   = CONFIG_INFO.plugin;
const PLATFORM_NAME = CONFIG_INFO.platform;

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
export default (homebridge) => {
  _debug(`homebridge API version: v${homebridge.version}`);

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
        _debug(`Terminating the garage controller..... Init: ${this._garageController.Initialized}`);
        await this._garageController.Terminate();
        this._garageController = undefined;
      }
    }
    // Lastly eliminate myself.
    delete this;
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
      callback(null, "platform", true, {"platform":PLATFORM_NAME});
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
    this._garageController = new _garageSystem();
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
    /*
     * this is called when HomeKit wants to retrieve the current state of the characteristic as defined in our getServices() function
     * it's called each time you open the Home app or when you open control center
     */
     let error = null;
     let doorCharacteristicVal = _Characteristic.CurrentDoorState.STOPPED;

     if (options.hasOwnProperty('key')) {
       // Get the name of the door.
       const name = options.key;

       /* Log to the console the value whenever this function is called */
       _debug(`calling _getCurrentDoorState: ${name}`);

       // Get the state for the door and update the accessory.
       const doorState = this._garageController.GetDoorState(name);
       // Translate the state into a characteristic value.
       doorCharacteristicVal = ((doorState === 'OPEN') ? _Characteristic.CurrentDoorState.OPEN : _Characteristic.CurrentDoorState.CLOSED);

     }
     else {
       error = new Error(`options did not include a key`);
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
       _debug(`calling _changeTargetDoorState: ${name}`);

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
        _debug(`_validateTargetDoorStateChange: ${name} Lock is not unsecured (${doorLocked})`);
      }

      // Was an error encountered?
      if (error != null) {
        // Yes. Reset the target door state.
        const charTargetDoorState = this._findCharacteristic(name, _Service.GarageDoorOpener, _Characteristic.TargetDoorState);
        if (charTargetDoorState instanceof _Characteristic) {
          // Reset to the cached value, but do so asynchronously.
          setTimeout((resetVal, characteristic) => {
            _debug(`_validateTargetDoorStateChange: resetting target door state to (${resetVal})`);
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

        // Get the default lock state (Bug#11)
        const defaultTargetLockState  = (this._garageController.GetDoorLocked(doorName) ? _Characteristic.LockTargetState.SECURED   : _Characteristic.LockTargetState.UNSECURED);
        const defaultLockState        = (this._garageController.GetDoorLocked(doorName) ? _Characteristic.LockCurrentState.SECURED  : _Characteristic.LockCurrentState.UNSECURED);

        /* Target Lock State (Optional) */
        const targetLockStateCharateristic = doorService.getCharacteristic(_Characteristic.LockTargetState);
        // Register for the 'change'
        targetLockStateCharateristic.on('change', this._changeTargetLockState.bind(this, {key:doorName}));
        // Ensure that the target lock state always defaults as specified
        targetLockStateCharateristic.updateValue(_Characteristic.LockTargetState.SECURED);
        targetLockStateCharateristic.updateValue(defaultTargetLockState);

        /* Current Lock State (Optional) */
        const currentLockStateCharacteristic = doorService.getCharacteristic(_Characteristic.LockCurrentState);
        // Register for the 'change'. Needed to track/cache the current lock state.
        currentLockStateCharacteristic.on('change', this._changeCurrentLockState.bind(this, {key:doorName}));
        // Ensure that the current lock state always defaults as specified.
        currentLockStateCharacteristic.updateValue(_Characteristic.LockCurrentState.SECURED);
        currentLockStateCharacteristic.updateValue(defaultLockState);

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

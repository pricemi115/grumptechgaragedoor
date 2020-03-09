# GrumpTech Garage Door
----------------------
A plug-in component for [Homebridge](https://github.com/nfarina/homebridge "GitHub link") that provides control and status of one or more garage doors using a Raspberry PI. _(some assembly required)_

To provide some measure of security, preventing unintended opening/closing of the doors, a _software_ lock will prevent control of the door. The lock is enabled by default and the state of the lock is not preserved between sessions.

_GrumpTech Garage Door_ supports both a proximity switch and [sonar based sensors](https://lastminuteengineers.com/arduino-sr04-ultrasonic-sensor-tutorial/ "HC-SR04") to detect the state of the door.

## Installation
This module is not intended to provide an extensible _API_ and, as such is best installed globally.

> npm install -g grumptechgaragedoor

##  Configuration
The plug-in allows for user specified configuration of the digital input/output lines to use as well as the type of sensors to use for detecting the door. The *config_sample.json* file located in *./config* shows an example of many of the user configurable settings.

### Bridge
> **username**:
Identifier in the form of a globally-unique colon-delimited EUI-48 multicast [MAC](https://en.wikipedia.org/wiki/MAC_address "MAC Address") address.  
Value(s): MAC Address in the form (xx:xx:xx:xx:xx:xx)
### Platforms (platforms)
An array of platforms supported/published by the bridge. Currently, there is only one platform for this plugin.
> **platform**:
Identifier for the name of the Homebridge platform. Must match the text in the *config_info/platform* entry of the package.json file.  
Value(s): Any valid non-null string.  
*Recommended to leave as-is.*  
> **name**:
Identifier for the name of the Homebridge plug-in. Must match the text in the *config_info/plugin* entry of the package.json file.  
Value(s): Any valid non-null string.  
*Recommended to leave as-is.*
#### System (system)
Settings used to define & configure the garage door system.
> **gpio_mode**:
*(Optional)* Specify the pin numbering system to use for identifying & accessing the digital input/output resources on the Raspberry Pi.  
Value(s): [BCM, RPI]  
Default: BCM  
Refer to the [rpi-gpio](https://github.com/JamesBarwell/rpi-gpio.js, "rpi-gpio") node module for more documentation.  
*Note: Most development and testing was done using BCM mode*  
> **heartbeat**:
*(Optional)* The digital output used to toggle a heartbeat. Assumed to be connected to a LED.  
Value(s): Any valid digital output resource on the RPi.  
Default: 4 (BCM)
*Must be specified according to the 'gpio_mode'.*
#### Doors (doors)
An array of doors in the system.  
> **name**:
Identifier for the door.  
Value(s): Any valid non-null string.  
*Note*: Door names must be unique as they are used internally for identification.  
> **state_indicator**:
The digital output used to show the state of the door. Assumed to be connected to a LED.  
Values(s): Any valid digital output resource on the RPi.  
> **control_request**:
The digital output used to control a relay that is used to  initiate the door open/close operation.  
Values(s): Any valid digital output resource on the RPi.  
> **manual_control_reqest**:
The digital input that is used to initiate a door open/close operation from direct hardware access. Assumed to be a push button or some other form of digital input control.  
Value(s): Any valid digital input resource on the RPi.

##### Detection Sensors (detect_sensors)
An array of sensors used to detect the state of the door. The plug-in only functionally supports two active sensors. One sensor to detect the door opening and another to detect closing. Additional sensors can be specified even though not active, which can be helpful during development & debug.
> **id**:
_Unique_ name identifying this sensor.  
Value(s): Any non-null string.  
Remark(s): the _id_ field is only used for debugging. Uniqueness of the name is not checked or enforced.  
> **class**:
Classification/Type for this sensor.  
Value(s): String representing any supported sensor type. [SonarSensor, ProximitySwitchSensor].  
Remark(s): Case sensitive.  
> **function**:
Detection function for this sensor.  
Value(s): String specifying the function. [OPEN, CLOSE]  
Remark(s): Only the first 'OPEN' and 'CLOSE' sensor will be detected. A function other than 'OPEN' or 'CLOSE' will be ignored.
###### Sensor Configuration (config)
A collection of configuration settings appropriate for the sensor classification specified.  

Sonar Sensors  
> **polling_interval**:
> **trigger_out**:
> **echo_in**:
> **distance_threshold_change_notification**:
> **detect_threshold_min**:
> **detect_threshold_max**:

Proximity Sensor  
> **detect_in**:
> **debounce_time**:
> **mode**:

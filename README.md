# GrumpTech Garage Door
----------------------
A plug-in component for [Homebridge](https://github.com/nfarina/homebridge "GitHub link") that provides control and status of one or more garage doors using a Raspberry PI. _(some assembly required)_

To provide some measure of security, preventing unintended opening/closing of the doors, a _software_ lock will prevent control of the door. The lock is enabled by default and the state of the lock is not preserved between sessions.

_GrumpTech Garage Door_ supports both a proximity switch and [sonar based](https://lastminuteengineers.com/arduino-sr04-ultrasonic-sensor-tutorial/ "HC-SR04") sensors to detect the state of the door.

## Installation
This module is not intended to provide an extensible _API_.

> npm i homebridge-grumptechgaragedoor

##  Configuration
The plug-in allows for user specified configuration of the digital input/output lines to use as well as the type of sensors to use for detecting the door. The *config_sample.json* file located in *./config* shows an example of many of the user configurable settings.

### Bridge<br />(bridge)
Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`username` | Identifier in the form of a globally-unique colon-delimited EUI-48 multicast [MAC](https://en.wikipedia.org/wiki/MAC_address "MAC Address") address. | MAC Address | | Takes the form (xx:xx:xx:xx:xx:xx)

### Platforms<br />(platforms)
Settings for the GrumpTech Garage Door platform.

Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`platform` | Identifier for the name of the Homebridge platform.  | Any valid non-null string | GrumpTechGarageSystemPlatform |Must match the text in the *config_info/platform* entry of the package.json file.<br /><br />*Recommended to leave as-is.*
`name` | Identifier for the name of the Homebridge plug-in. | Any valid non-null string | homebridge-GrumpTechGarageSystem | Identifier for the name of the Homebridge plug-in. Must match the text in the *config_info/plugin* entry of the package.json file.<br /><br />*Recommended to leave as-is.*

#### System<br />(platforms/platform/system)
Settings used to define & configure the garage door system.

Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`gpio_mode` | *(Optional)* Specify the pin numbering system to use for identifying & accessing the digital input/output resources on the Raspberry Pi. | BCM, RPI | BCM |Refer to the [rpi-gpio](https://github.com/JamesBarwell/rpi-gpio.js "rpi-gpio") node module for more documentation.<br /><br />*Note: Most development and testing was done using BCM mode*
`heartbeat` | *(Optional)* The digital output used to toggle a heartbeat. | Any valid digital output resource on the RPi | 4 (BCM) / 7 (RPI) | Assumed to be connected to a LED or other indicator.<br /><br />*Must be specified according to the 'gpio_mode'.*

#### Doors<br />(platforms/platform/system/doors)
An array of doors in the system.  

Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`name` | Identifier for the door | Any valid non-null string | | Door names must be unique, as they are used internally for identification.
`state_indicator` | The digital output used to show the state of the door | Any valid digital output resource on the RPi | | Assumed to be connected to a LED or other indicator.<br /><br />*Must be specified according to the 'gpio_mode'.*
`control_request` | The digital output used to control a relay that is used to initiate the door open/close operation | Any valid digital output resource on the RPi | | *Must be specified according to the 'gpio_mode'.*
`manual_control_reqest` | The digital input that is used to initiate a door open/close operation from direct hardware access. | Any valid digital input resource on the RPi | | Assumed to be a push button or some other form of digital input control.<br /><br />*Must be specified according to the 'gpio_mode'.*

#### Detection Sensors<br />(platforms/platform/system/doors/detect_sensors)
An array of sensors used to detect the state of the door. The plug-in only functionally supports two active sensors. One sensor to detect the door opening and another to detect closing. Additional sensors can be specified even though not active, which can be helpful during development & debug.

Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`id` | *Unique* name identifying this sensor | Any non-null string | | The *id* field is only used for debugging.<br />Uniqueness of the name is not checked or enforced
`class` | Classification/Type for this sensor | SonarSensor, ProximitySwitchSensor | | Case sensitive
`function` | Detection function for this sensor | OPEN, CLOSE | | Only the first _OPEN_ and _CLOSE_ sensor will be detected. A function other than _OPEN_ or _CLOSE_ will be ignored.<br /><br /> Case Insensitive.

#### Sensor Configuration<br />(platforms/platform/system/doors/detect_sensors/config)
A collection of configuration settings appropriate for the sensor classification specified.  

Sonar Sensors  

Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`polling_interval` | *(Optional)* Interval, specified in seconds, over which to measure distance from the sensor | Any positive number greater than or equal to 0.25 seconds. | 5.0 seconds | The minimum bound accounts for the maximum measurement cycle of 60ms-100ms and prevents overlapping trigger requests with the resulting echo signal
`trigger_out` | The digital output used to initiate a sonar distance measurement. | Any valid digital output resource on the RPi. | | *Must be specified according to the 'gpio_mode'.*
`echo_in` | The digital input that is used read the *echo* signal from the sensor, which is used to determine the distance to the object being measured. | Any valid digital input resource on the RPi | | *Must be specified according to the 'gpio_mode'.*
`distance_threshold_change_notification` | *(Optional)* Distance threshold, specified in meters, which must be exceeded for the sensor to raise a *distance_changed* event. | Any positive number greater than 0.0 | 0.08 meters | The *distance_changed* event is not currently used in this application |
`detect_threshold_min` | Minimum threshold, specified in meters, to define a measurement range for detecting the object. | Any number greater than or equal to 0.0 | | Used in conjunction with `detect_threshold_max`. Distance measurements outside of the defined range will result in the sensor indicating that the object is *not detected*<br /><br />Must be less than `detect_threshold_max`
`detect_threshold_max` | Maximum threshold, specified in meters, to define a measurement range for detecting the object. | Any number greater than 0.0 | | Used in conjunction with `detect_threshold_min`. Distance measurements outside of the defined range will result in the sensor indicating that the object is *not detected*<br /><br />Must be greater than `detect_threshold_min`

Proximity Sensor  

Key | Description | Value(s) | Default(s) | Remark(s)
:--- | :----------- | :-------- | :---------- | :---------
`detect_in` | The digital input that is used to detect the door state, as defined by the sensor | Any valid digital input resource on the RPi | | *Must be specified according to the 'gpio_mode'.*
`debounce_time` | *(Optional)* The time, in seconds, to debounce the sensor input | Any number greater than or equal to 1.0 | 1.0 *second* | This is the time required to see no further signal change after detecting the most recent signal state change
`mode` | *(Optional)* Flag indicating if the switch is configured as _normally closed_ or _normally open_ | true, false | true | _true_ indicates _normally closed_  and _false_ indicates _normally open_

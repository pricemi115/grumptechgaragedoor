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
> username: Identifier in the form of a  globally-unique colon-delimited EUI-48 multicast [MAC](https://en.wikipedia.org/wiki/MAC_address "MAC Address") address. (xx:xx:xx:xx:xx:xx)

### Platforms/Platform
> platform: Identifier for the name of the Homebridge platform. Must match the text in the *config_info/platform* entry of the package.json file. Recommended to leave as-is.

> name: Identifier for the name of the Homebridge plug-in. Must match the text in the *config_info/plugin* entry of the package.json file. Recommended to leave as-is.
#### system
> gpio_mode: Specify the mode for identifying & accessing the digital input/output pins on the Raspberry Pi.  Values: BCM, 

> heartbeat: The digital output pin used to toggle a heartbeat LED. Values: any valid pin on the RPi.
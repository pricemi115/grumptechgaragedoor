# GrumpTech Garage Door
----------------------
A plug-in component for [Homebridge](https://github.com/nfarina/homebridge "GitHub link") that provides control and status of one or more garage doors using a Raspberry PI. _(some assembly required.)_

To provide some measure of security, preventing unintended opening/closing of the doors, a _software_ lock will prevent control of the door. The lock is enabled by default and the state of the lock is not preserved between sessions.

_GrumpTech Garage Door_ supports both a proximity switch and [sonar based sensors](https://lastminuteengineers.com/arduino-sr04-ultrasonic-sensor-tutorial/ "HC-SR04") to detect the state of the door.

## Installation
This module is not intended to provide an extensible _API_ and, as such is best installed globally.

> npm install -g grumptechgaragedoor

##  Configuration 
The plug-in allows for user specified configuration of the digital input/output lines to use as well as the type of sensors to use for detecting the door.
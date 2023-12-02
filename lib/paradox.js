let newLine = String.fromCharCode("13");
let paradoxSerialTiming = 100;


function pad(num, size) {
    var s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

String.prototype.unaccent = function () {
    return this.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

String.prototype.replaceAll = function (search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, 'g'), replacement);
};

var zoneToHASSLabel = {};
var device = {};

var payload_disarm = "disarmed";
var payload_arm_home = "armed_home";
var payload_arm_away = "armed_away";
var payload_arm_night = "armed_night";
var area_current_state = "paradox/states/partitions/%s/state"
var area_set_state = "paradox/states/partitions/%s/set"

module.exports = class ParadoxConnector {

    constructor(configuration) {

        if (!configuration) {
            throw ("Configuration Required...");
        }

        this._config = configuration;
        this._buffer = "";
        device = {
            "identifiers": ["Paradox_EVO_0x123abc"],
            "name": "Paradox Alarm Panel",
            "manufacturer": "Paradox",
            "model": "EVO 192"
        }
    }

    Connect() {
        let mqtt = require("mqtt");

        if (!this._config.mqttAddress) {
            this._config.mqttAddress = "mqtt://localhost";
        }

        var authParams;
        if (this._config.mqttUsername && this._config.mqttPassword) {
            authParams = {"username": this._config.mqttUsername, "password": this._config.mqttPassword};
        }

        this._mqttClient = mqtt.connect(this._config.mqttAddress, authParams);
        this._mqttClient.on("connect", () => {
            console.log("MQTT Connected!");
            this._mqttClient.on('message', (topic, message) => {

                var cmd = message.toString();
                
                var topicParts = topic.split("/");
                switch (topicParts[2]) {
                    case "area":
                        var area = +topicParts[3];
                        var paddedArea = pad(area, 3);

                        console.log("Received alarm state change from HA: " + cmd);
                        switch (cmd) {
                            case "ARM":
                                this.SendCommand("AA" + paddedArea + "S" + this._config.panelUserCode);
                                this._msg = "armed_home";
                                break;
                            case "ARM_AWAY":
                                this.SendCommand("AA" + paddedArea + "A" + this._config.panelUserCode);
                                this._msg = "armed_away";
                                break;
                            case "DISARM":
                                this.SendCommand("AD" + paddedArea + this._config.panelUserCode);
                                break;
                        }

                        break;

                    case "virtual_zone":
                        var zone = +topicParts[3];
                        var paddedZone = pad(zone, 3);

                        if (cmd === "OPEN") {
                            this.SendCommand("VO" + paddedZone);
                        } else if (cmd === "CLOSED") {
                            this.SendCommand("VC" + paddedZone);
                        }

                        break;

                    case "status":
                        switch (topicParts[3]) {
                            case "zone":
                                this.GetInitialZoneStatus();
                                break;
                            case "area":
                                this.GetPanelStatus();
                                break;
                        }
                        break;
                }
            });

            for (var index = 1; index <= this._config.areaCount; index++) {
                this._mqttClient.subscribe(parse(area_set_state, index));
            }
            this.SendMQTTEvent("paradox/interface/availability", "online");
        });

        return this.ConnectSerial();
    }

    ConnectSerial() {
        const { SerialPort } = require("serialport");

        this._port = new SerialPort({
                path: '/dev/' + this._config.device,
                baudRate: this._config.baudRate
            });


        var connectPromise = new Promise((resolve, reject) => {
            this._port.on('open', () => {
                console.log("Serial Port: " + this._config.device + " opened.");

                this._port.on('readable', (data) => {
                    var text = this._port.read();
                    this._buffer += text;
                    var parts = this._buffer.split(newLine);
                    for (var index = 0; index < parts.length - 1; index++) {
                        this.TranslateCommand(parts[index].trim());
                    }

                    this._buffer = parts[parts.length - 1];
                });

                resolve();
            });
        });

        // Get the labels, initial status, and panel status
        // panel status will be useful once we start controlling the alarm status
        var init = connectPromise
            .then(() => {
                return this.RegisterVirtualZones();
            })
            .then(() => {
                return this.GetZoneLabels();
            })
            .then(() => {
                return this.GetUserLabels();
            })
            .then(() => {
                return this.GetAreaLabels();
            })
            .then(() => {
                return this.GetInitialZoneStatus();
            })
            .then(() => {
                return this.GetPanelStatus();
            })
            .then(() => {
                return this.RegisterVirtualPGMs();
            })

        this._port.on('close', () => {
            console.log("Port Closed... Will retry to open in 5 seconds");
            setTimeout(() => {
                this.ConnectSerial();
            }, 5000);
        });

        this._port.on('error', (e) => {
            console.log("Error opening port. Retrying in 5 seconds.", e);
            setTimeout(() => {
                this.ConnectSerial();
            }, 5000);
        });


        return init;
    }

    GetGenericStatus(id, count) {
        // Note that this function is only responsible for sending commands
        // not processing them
        return new Promise((resolve, reject) => {
            var index = 0;
            var int = setInterval(() => {
                this.SendCommand(id + pad(++index, 3));
                if (index === count) {
                    clearInterval(int);
                    resolve();
                }
            }, paradoxSerialTiming);
        });
    }

    GetGenericZoneStatus(id) {
        // Note that this function is only responsible for sending commands
        // not processing them
        return new Promise((resolve, reject) => {
            var zoneKeys = Object.keys(this._config.zoneConfiguration);
            var count = zoneKeys.length;
            var index = 0;
            var int = setInterval(() => {
                var zoneKey = zoneKeys[index++];
                this.SendCommand(id + pad(zoneKey, 3));
                if (index === count) {
                    clearInterval(int);
                    resolve();
                }
            }, paradoxSerialTiming);
        });

    }

    GetZoneLabels() {
        return this.GetGenericZoneStatus("ZL");
    }

    GetUserLabels() {
        return this.GetGenericStatus("UL", this._config.userCount);
    }

    GetAreaLabels() {
        return this.GetGenericStatus("AL", this._config.areaCount);
    }

    GetInitialZoneStatus() {
        return this.GetGenericZoneStatus("RZ");
    }

    GetPanelStatus() {
        return new Promise((resolve, reject) => {
            var index = 1;
            var int = setInterval(() => {
                var paddedArea = pad(index, 3);
                this.SendCommand("RA" + paddedArea);
                if (index++ === this._config.areaCount) {
                    clearInterval(int);
                    resolve();
                }
            }, paradoxSerialTiming);
        });
    }

    RegisterVirtualPGMs() {
        return new Promise((resolve, reject) => {

            if (!this._config.pgmConfiguration) {
                resolve();
            }

            var keys = Object.keys(this._config.pgmConfiguration);
            keys.forEach((key) => {
                this._config.pgmConfiguration[key]["state_topic"] = "homeassistant/binary_sensor/paradox_vpgm" + key + "/state";
                var payload = JSON.stringify(this._config.pgmConfiguration[key]);

                console.log("Registering Virtual PGM: paradox_vpgm" + key + " with HA with payload: " + payload);
                this.SendMQTTEvent("homeassistant/binary_sensor/paradox_vpgm" + key + "/config", payload);
            });

            resolve();
        });
    }

    RegisterVirtualZones() {
        return new Promise((resolve, reject) => {

            if (!this._config.virtualZoneConfiguration) {
                resolve();
            }

            var keys = Object.keys(this._config.virtualZoneConfiguration);

            keys.forEach((key) => {
                console.log("Subscribing: paradox_evo/alarm/virtual_zone/" + key + "/set");
                this._mqttClient.subscribe("paradox_evo/alarm/virtual_zone/" + key + "/set");
            });
            resolve();
        });

    }

    TranslateCommand(command) {
        if (command.indexOf("G") === 0) {
            this.ProcessSystemEvent(command);
        } /*else if (command.indexOf("PGM") === 0) {
            var pgmNum = +command.substring(3, 5);
            var state = command.substring(5, 7) === "ON" ? "ON" : "OFF";

            this.SendMQTTEvent("homeassistant/binary_sensor/paradox_vpgm" + pgmNum + "/state", state);
        } else if (command.indexOf("ZL") === 0) {
            var zone = +command.substring(2, 5);
            var zoneConfiguration = this._config.zoneConfiguration;

            if (zoneConfiguration[zone]) {
                var label = command.substring(5, command.length).trim();
                var nospc = (zoneConfiguration[zone].name ? zoneConfiguration[zone].name : label).replaceAll(" ", "_").unaccent().toLowerCase();

                if (!zoneConfiguration[zone].name) {
                    zoneConfiguration[zone] = Object.assign(zoneConfiguration[zone], {name: label});
                }
                zoneToHASSLabel[zone] = nospc;
                zoneConfiguration[zone]["state_topic"] = "homeassistant/binary_sensor/" + nospc + "/state";
                zoneConfiguration[zone]["unique_id"] = nospc;
                zoneConfiguration[zone]["device"] = {
                    "identifiers": ["Paradox_EVO_0x123abc"],
                    "name": "Paradox Alarm Panel",
                    "manufacturer": "Paradox",
                    "model": "EVO 192"
                };
                var payload = JSON.stringify(zoneConfiguration[zone]);

                console.log("Registering Zone: " + nospc + " with HA with payload: " + payload);
                this.SendMQTTEvent("homeassistant/binary_sensor/" + nospc + "/config", payload);
            }
        } else if (command.indexOf("RZ") === 0) {
            //RZ010COOOO
            var zone = +command.substring(2, 5);
            var nospc = zoneToHASSLabel[zone];
            var status = command.substring(5, 6);
            var zoneConfiguration = this._config.zoneConfiguration;
            console.log("Sending default status for: " + nospc + ", Status: " + status);
            switch (status) {
                case "O":
                    this.SendMQTTEvent("homeassistant/binary_sensor/" + nospc + "/state", "ON");
                    break;
                case "C":
                    this.SendMQTTEvent("homeassistant/binary_sensor/" + nospc + "/state", "OFF");
                    break;
            }

            this.ForwardVirtualZoneStatus(zone, status === "O");

        }*/ else if (command.indexOf("RA") === 0) {
            //RA001DOOOOOO
            var status = command.substring(5, 6);
            var alarmStatus = command.substring(10, 11);
            var area = +command.substring(2, 5);
            var state;
            switch (status) {
                case "D":
                    state = payload_disarm;
                    break;
                case "A":
                case "F":
                case "I":
                    state = payload_arm_away;
                    break;
                case "S":
                    state = payload_arm_home;
                    break;
            }
            if (alarmStatus === "A") {
                state = "triggered";
            }

            this.SendMQTTEvent(parse(area_current_state, area), state);
            console.log("Sending default state for area " + area + ": " + state + " to: " + parse(area_current_state, area));

        } else if (command.indexOf("AA") === 0) {
            var area = +command.substring(2, 5);
            if (command.split("&")[1] === "ok") {
                console.log("Arm OK for Area: " + area);
                this.SendMQTTEvent(parse(area_current_state, partition), payload_arm_away);
            }
        } else if (command.indexOf("AD") === 0) {
            var area = +command.substring(2, 5);
            if (command.split("&")[1] === "ok") {
                console.log("Disarm OK for Area: " + area);
                this.SendMQTTEvent(parse(area_current_state, partition), payload_disarm);
            }
        } /*else if (command.indexOf("VC") === 0) { //TODO not supported
            var zone = +command.substring(2, 5);
            if (command.split("&")[1] === "ok") {
                //this.SendMQTTEvent("paradox_evo/alarm/virtual_zone/" + zone, "CLOSED");
            }
        } else if (command.indexOf("VO") === 0) { //TODO not supported
            var zone = +command.substring(2, 5);
            if (command.split("&")[1] === "ok") {
                //handled by zone update call.
                //this.SendMQTTEvent("paradox_evo/alarm/virtual_zone/" + zone, "OPEN");
            }
        } */else if (command.indexOf("AL") === 0) {
            var partition = +command.substring(2, 5);
            var name = command.substring(5, command.length).trim();
            var partitionData = {
                name: name,
                code_arm_required: true, //TODO Variable
                code_disarm_required: true, //TODO Variable
                code: this._config.panelUserCode,
                device: device,
                state_topic: parse(area_current_state, partition),
                command_topic: parse(area_set_state, partition),
                payload_disarm: payload_disarm,
                payload_arm_home: payload_arm_home,
                payload_arm_away: payload_arm_away,
                payload_arm_night: payload_arm_night,
                unique_id: "paradox_" + this._config.name + "_partition_" + name,
                availability_topic: "paradox/interface/availability"
            };
            var payload = JSON.stringify(partitionData);
            
            this.SendMQTTEvent("homeassistant/alarm_control_panel/" + this._config.name + "/" + name + "/config", payload);
        } else {
            console.log("Unknown message from panel: " + command);
        }
    }

    ForwardVirtualZoneStatus(panelZone, isOpen) {
        if (!this._config.virtualZoneConfiguration) {
            return;
        }

        // If a virtual zone is assigned to this zone, send a mqtt message update for it.
        var keys = Object.keys(this._config.virtualZoneConfiguration);
        keys.forEach((key) => {
            if (panelZone === this._config.virtualZoneConfiguration[key].panelZone) {
                this.SendMQTTEvent("paradox_evo/alarm/virtual_zone/" + key, isOpen ? "OPEN" : "CLOSED");
            }
        });
    }


    ProcessSystemEvent(event) {
        //G000N004A001
        var eventGroup = +(event.substring(1, 4));
        var eventNumber = +(event.substring(5, 8));
        var area = +(event.substring(9, 12));

        console.error("Received event " + event);

        switch (eventGroup) {
            case 0: // Zone is OK
                var nospc = zoneToHASSLabel[eventNumber];
                this.SendMQTTEvent("homeassistant/binary_sensor/" + nospc + "/state", "OFF");
                this.ForwardVirtualZoneStatus(eventNumber, false);
                break;
            case 1: // Zone is Open
                var nospc = zoneToHASSLabel[eventNumber];
                this.SendMQTTEvent("homeassistant/binary_sensor/" + nospc + "/state", "ON");
                this.ForwardVirtualZoneStatus(eventNumber, true);
                break;
            case 13:
            case 14:
            case 15:
            case 16:
            case 17:
            case 18:
            case 19:
            case 20:
                this.SendMQTTEvent(parse(area_current_state, area), payload_disarm);
                break;
            case 22:
                switch (eventNumber) {
                    case 2:
                        this.SendMQTTEvent(parse(area_current_state, area), payload_disarm);
                        break;
                }
                break;
            case 24:
            case 25:
            case 30:
                this.SendMQTTEvent(parse(area_current_state, area), "triggered");
                break;
            case 64:
                switch (eventNumber) {
                    case 2:
                        console.log("PARADOX armed HOME");
                        this.SendMQTTEvent(parse(area_current_state, area), payload_arm_home);
                        break;
                    case 0:
                    case 1:
                    case 3:
                        console.log("PARADOX armed AWAY");
                        this.SendMQTTEvent(parse(area_current_state, area), payload_arm_away);
                        break;

                }
                break;

        }
    }

    SendMQTTEvent(topic, payload) {
        this._mqttClient.publish(topic, payload, {
            retain: true
        });
    }

    SendCommand(command) {
        this._port.write(command + newLine);
    }

}

function parse(str) {
    var args = [].slice.call(arguments, 1),
        i = 0;

    return str.replace(/%s/g, () => args[i++]);
}
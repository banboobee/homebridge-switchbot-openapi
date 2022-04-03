import { Service, PlatformAccessory, CharacteristicValue, HAPStatus } from 'homebridge';
import { SwitchBotPlatform } from '../platform';
import { interval, Subject } from 'rxjs';
import { debounceTime, skipWhile, tap } from 'rxjs/operators';
import { DeviceURL, device, deviceStatusResponse } from '../settings';
import { AxiosResponse } from 'axios';
import Persist from 'node-persist';
import * as path from 'path';

interface currentState {
  CurrentPosition: CharacteristicValue;
  PositionState: CharacteristicValue;
  TargetPosition: CharacteristicValue;
};

export class Curtain {
  private service: Service;

  state!: currentState;
  deviceStatus!: deviceStatusResponse;
  setNewTarget!: boolean;
  setNewTargetTimer!: NodeJS.Timeout;

  curtainUpdateInProgress!: boolean;
  doCurtainUpdate;

  async setupPersist(user: string): Promise<void> {
    const log = this.platform.log;
    const persist = Persist.create();
    const device: string = this.device.deviceId?.toLowerCase()
	  .match(/[\s\S]{1,2}/g)?.join(':') || '';
    await persist.init(
      {dir: path.join(user, 'plugin-persist', 'homebridge-switchbot-openapi'),
       forgiveParseErrors: true
      });
    let state: currentState = await persist.getItem(device) || this.state;
    this.platform.log.debug('setupPersist:', JSON.stringify(state));
    this.state = new Proxy(state, {
      set: function(target:any, key:PropertyKey, value:any, receiver:any):boolean {
	try {
	  persist.setItem(device, target)
	} catch(e) {
	  log.error(`${device} is unable to set state persist`, e);
	}
	return Reflect.set(target, key, value, receiver);
      }.bind(this)
    })
  }

  constructor(
    private readonly platform: SwitchBotPlatform,
    private accessory: PlatformAccessory,
    public device: device,
  ) {
    // default placeholders
    this.setMinMax();
    this.state = {
      CurrentPosition: 0,
      TargetPosition: 0,
      PositionState: this.platform.Characteristic.PositionState.STOPPED
    }
    //this.setupPersist(this.platform.User.storagePath());

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doCurtainUpdate = new Subject();
    this.curtainUpdateInProgress = false;
    this.setNewTarget = false;

    // Retrieve initial values and updateHomekit
    //this.refreshStatus();

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.platform.Characteristic.Model, 'SWITCHBOT-CURTAIN-W0701600')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceId);

    // get the WindowCovering service if it exists, otherwise create a new WindowCovering service
    // you can create multiple services for each accessory
    (this.service =
      accessory.getService(this.platform.Service.WindowCovering) ||
      accessory.addService(this.platform.Service.WindowCovering)), '%s %s', device.deviceName, device.deviceType;

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // accessory.getService('NAME') ?? accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/WindowCovering

    // create handlers for required characteristics
    this.service.setCharacteristic(this.platform.Characteristic.PositionState, this.state?.PositionState);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .setProps({
        minStep: this.platform.config.options?.curtain?.set_minStep || 1,
        minValue: 0,
        maxValue: 100,
        validValueRanges: [0, 100],
      })
      .onGet(() => {
	this.mqttpublish('CurrentPosition', this.state?.CurrentPosition);
        return this.state?.CurrentPosition;
      });

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .setProps({
        minStep: this.platform.config.options?.curtain?.set_minStep || 1,
        validValueRanges: [0, 100],
      })
      .onSet(this.TargetPositionSet.bind(this));

    // Update Homekit
    //this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.platform.config.options!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.curtainUpdateInProgress))
      .subscribe(() => {
        this.refreshStatus();
      });

    // update slide progress
    interval(this.platform.config.options!.curtain!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.curtainUpdateInProgress))
      .subscribe(() => {
        if (this.state?.PositionState === this.platform.Characteristic.PositionState.STOPPED) {
          return;
        }
        this.platform.log.debug('Refresh status when moving', this.state?.PositionState);
        this.refreshStatus();
      });


    // Watch for Curtain change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    this.doCurtainUpdate
      .pipe(
        tap(() => {
          this.curtainUpdateInProgress = true;
        }),
        debounceTime(this.platform.config.options!.pushRate! * 1000),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges();
        } catch (e: any) {
          this.platform.log.error(JSON.stringify(e.message));
          this.platform.log.debug('Curtain %s -', accessory.displayName, JSON.stringify(e));
          this.apiError(e);
        }
        this.curtainUpdateInProgress = false;
      });

    this.initializeStatus();
  }

  async initializeStatus() {
    await this.setupPersist(this.platform.User.storagePath());
    await this.updateHomeKitCharacteristics();
    await this.refreshStatus();
  }

  mqttpublish(topic: string, message: any) {
    //console.trace();
    const mac = this.device.deviceId?.toLowerCase().match(/[\s\S]{1,2}/g)?.join(':');
    this.platform.mqtt?.publish(
      `homebridge-switchbot-openapi/${mac}/${topic}`,
      `${message}`
    );
  }

  parseStatus() {
    // CurrentPosition
    this.setMinMax();
    this.state.CurrentPosition = 100 - this.deviceStatus.body.slidePosition!;
    this.setMinMax();
    this.platform.log.debug(
      'Curtain %s CurrentPosition -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.state?.CurrentPosition,
    );
    if (this.setNewTarget) {
      this.platform.log.info(
        'Checking %s Status ...',
        this.accessory.displayName,
      );
    }

    if (this.deviceStatus.body.moving) {
      if (this.state?.TargetPosition > this.state?.CurrentPosition) {
        this.platform.log.debug(
          'Curtain %s -',
          this.accessory.displayName,
          'Current position:',
          this.state?.CurrentPosition,
          'closing',
        );
        this.state.PositionState = this.platform.Characteristic.PositionState.INCREASING;
      } else if (this.state?.TargetPosition < this.state?.CurrentPosition) {
        this.platform.log.debug(
          'Curtain %s -',
          this.accessory.displayName,
          'Current position:',
          this.state?.CurrentPosition,
          'opening',
        );
        this.state.PositionState = this.platform.Characteristic.PositionState.DECREASING;
      } else {
        this.platform.log.debug('Curtain %s -', this.state?.CurrentPosition, 'standby');
        this.state.PositionState = this.platform.Characteristic.PositionState.STOPPED;
      }
    } else {
      this.platform.log.debug(
        'Curtain %s -',
        this.accessory.displayName,
        'Current position:',
        this.state?.CurrentPosition,
        'standby',
      );
      if (!this.setNewTarget) {
        /*If Curtain calibration distance is short, there will be an error between the current percentage and the target percentage.*/
        this.state.TargetPosition = this.state?.CurrentPosition;
        this.state.PositionState = this.platform.Characteristic.PositionState.STOPPED;
      }
    }
    this.platform.log.debug(
      'Curtain %s CurrentPosition: %s, TargetPosition: %s, PositionState: %s',
      this.accessory.displayName,
      this.state?.CurrentPosition,
      this.state?.TargetPosition,
      this.state?.PositionState,
    );
  }

  async refreshStatus() {
    try {
      this.platform.log.debug('Curtain - Reading', `${DeviceURL}/${this.device.deviceId}/status`);
      const deviceStatus: deviceStatusResponse = (
        await this.platform.axios.get(`${DeviceURL}/${this.device.deviceId}/status`)
      ).data;
      if (deviceStatus.message === 'success') {
        this.deviceStatus = deviceStatus;
        this.platform.log.debug(
          'Curtain %s refreshStatus -',
          this.accessory.displayName,
          JSON.stringify(this.deviceStatus),
        );
        this.setMinMax();
        this.parseStatus();
        this.updateHomeKitCharacteristics();
      }
    } catch (e: any) {
      this.platform.log.error(
        `Curtain - Failed to refresh status of ${this.device.deviceName}`,
        JSON.stringify(e.message),
        this.platform.log.debug('Curtain %s -', this.accessory.displayName, JSON.stringify(e)),
      );
      this.apiError(e);
    }
  }

  async pushChanges() {
    if (this.state?.TargetPosition !== this.state?.CurrentPosition) {
      this.platform.log.debug(`Pushing ${this.state?.TargetPosition}`);
      const adjustedTargetPosition = 100 - Number(this.state?.TargetPosition);
      const payload = {
        commandType: 'command',
        command: 'setPosition',
        parameter: `0,ff,${adjustedTargetPosition}`,
      } as any;

      this.platform.log.info(
        'Sending request for',
        this.accessory.displayName,
        'to SwitchBot API. command:',
        payload.command,
        'parameter:',
        payload.parameter,
        'commandType:',
        payload.commandType,
      );
      this.platform.log.debug('Curtain %s pushChanges -', this.accessory.displayName, JSON.stringify(payload));

      // Make the API request
      const push = await this.platform.axios.post(`${DeviceURL}/${this.device.deviceId}/commands`, payload);
      this.platform.log.debug('Curtain %s Changes pushed -', this.accessory.displayName, push.data);
      this.statusCode(push);
    }
  }

  updateHomeKitCharacteristics() {
    this.platform.log.debug(
      'Curtain %s updateHomeKitCharacteristics -',
      this.accessory.displayName,
      JSON.stringify({
        CurrentPosition: this.state?.CurrentPosition,
        PositionState: this.state?.PositionState,
        TargetPosition: this.state?.TargetPosition,
      }),
    );
    this.setMinMax();
    if (this.state?.CurrentPosition !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.state?.CurrentPosition);
      this.mqttpublish('CurrentPosition', this.state?.CurrentPosition);
    }
    if (this.state?.PositionState !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state?.PositionState);
      this.mqttpublish('PositionState', this.state?.PositionState);
    }
    if (this.state?.TargetPosition !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.state?.TargetPosition);
      this.mqttpublish('TargetPosition', this.state?.TargetPosition);
    }
  }

  public apiError(e: any) {
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, e);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, e);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, e);
    new this.platform.api.hap.HapStatusError(HAPStatus.OPERATION_TIMED_OUT);
  }


  private statusCode(push: AxiosResponse<any>) {
    switch (push.data.statusCode) {
      case 151:
        this.platform.log.error('Command not supported by this device type.');
        break;
      case 152:
        this.platform.log.error('Device not found.');
        break;
      case 160:
        this.platform.log.error('Command is not supported.');
        break;
      case 161:
        this.platform.log.error('Device is offline.');
        break;
      case 171:
        this.platform.log.error('Hub Device is offline.');
        break;
      case 190:
        this.platform.log.error('Device internal error due to device states not synchronized with server. Or command fomrat is invalid.');
        break;
      case 100:
        this.platform.log.debug('Command successfully sent.');
        break;
      default:
        this.platform.log.debug('Unknown statusCode.');
    }
  }

  /**
   * Handle requests to set the value of the "Target Position" characteristic
   */
  TargetPositionSet(value: CharacteristicValue) {
    this.platform.log.debug('Curtain %s - Set TargetPosition: %s', this.accessory.displayName, value);

    this.state.TargetPosition = value;
    this.mqttpublish('TargetPosition', this.state?.TargetPosition);
    
    if (value > this.state?.CurrentPosition) {
      this.state.PositionState = this.platform.Characteristic.PositionState.INCREASING;
      this.setNewTarget = true;
      this.setMinMax();
    } else if (value < this.state?.CurrentPosition) {
      this.state.PositionState = this.platform.Characteristic.PositionState.DECREASING;
      this.setNewTarget = true;
      this.setMinMax();
    } else {
      this.state.PositionState = this.platform.Characteristic.PositionState.STOPPED;
      this.setNewTarget = false;
      this.setMinMax();
    }
    this.service.setCharacteristic(this.platform.Characteristic.PositionState, this.state?.PositionState);
    this.mqttpublish('PositionState', this.state?.PositionState);

    /**
     * If Curtain movement time is short, the moving flag from backend is always false.
     * The minimum time depends on the network control latency.
     */
    clearTimeout(this.setNewTargetTimer);
    if (this.setNewTarget) {
      this.setNewTargetTimer = setTimeout(() => {
        this.platform.log.debug(
          'Curtain %s -',
          this.accessory.displayName,
          'setNewTarget',
          this.setNewTarget,
          'timeout',
        );
        this.setNewTarget = false;
      }, 10000);
    }
    this.doCurtainUpdate.next();
  }

  public setMinMax() {
    if (this.platform.config.options?.curtain?.set_min) {
      if (this.state?.CurrentPosition <= this.platform.config.options?.curtain?.set_min) {
        this.state.CurrentPosition = 0;
      }
    }
    if (this.platform.config.options?.curtain?.set_max) {
      if (this.state?.CurrentPosition >= this.platform.config.options?.curtain?.set_max) {
        this.state.CurrentPosition = 100;
      }
    }
  }
}

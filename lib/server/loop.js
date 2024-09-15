'use strict';

const apn = require('@parse/node-apn');

function init(env, ctx) {

  function loop() {
    return loop;
  }

  loop.sendNotification = async function sendNotification(data, remoteAddress, completion) {
    let provider;
    let isCompleted = false;

    // Helper function to ensure 'completion' is called only once
    function safeCompletion(errorMessage, successMessage) {
      if (!isCompleted) {
        isCompleted = true;
        if (errorMessage) {
          completion(errorMessage);
        } else {
          completion(null, successMessage);
        }
      }
    }

    // Helper function to validate environment settings
    function validateEnvSetting(setting, name) {
      if (!setting || setting.length === 0) {
        throw new Error(`Loop notification failed: ${name} not set.`);
      }
    }

    // Helper function to check for non-empty strings
    function isNonEmptyString(value) {
      return typeof value === 'string' && value.trim().length > 0;
    }

    try {
      // Validate environment settings
      validateEnvSetting(env.extendedSettings.loop.apnsKey, 'LOOP_APNS_KEY');
      validateEnvSetting(env.extendedSettings.loop.apnsKeyId, 'LOOP_APNS_KEY_ID');
      validateEnvSetting(env.extendedSettings.loop.developerTeamId, 'LOOP_DEVELOPER_TEAM_ID');

      if (env.extendedSettings.loop.developerTeamId.length !== 10) {
        throw new Error('Loop notification failed: LOOP_DEVELOPER_TEAM_ID must be a 10-character string.');
      }

      // Validate profile settings
      if (!ctx.ddata.profiles || ctx.ddata.profiles.length < 1 || !ctx.ddata.profiles[0].loopSettings) {
        throw new Error('Loop notification failed: Could not find loopSettings in profile.');
      }

      let loopSettings = ctx.ddata.profiles[0].loopSettings;

      if (!isNonEmptyString(loopSettings.deviceToken)) {
        throw new Error('Loop notification failed: Could not find deviceToken in loopSettings.');
      }

      if (!isNonEmptyString(loopSettings.bundleIdentifier)) {
        throw new Error('Loop notification failed: Could not find bundleIdentifier in loopSettings.');
      }

      // Initialize APNs provider
      const options = {
        token: {
          key: env.extendedSettings.loop.apnsKey,
          keyId: env.extendedSettings.loop.apnsKeyId,
          teamId: env.extendedSettings.loop.developerTeamId,
        },
        production: env.extendedSettings.loop.pushServerEnvironment === 'production',
      };

      provider = new apn.Provider(options);

      // Build payload and alert
      const payload = {
        'remote-address': remoteAddress,
      };

      let alert;

      // Event-specific handling
      if (data.eventType === 'Temporary Override Cancel') {
        payload['cancel-temporary-override'] = 'true';
        alert = 'Cancel Temporary Override';
      } else if (data.eventType === 'Temporary Override') {
        if (!isNonEmptyString(data.reason)) {
          throw new Error("Loop notification failed: 'reason' is required for Temporary Override.");
        }
        payload['override-name'] = data.reason;

        if (data.duration !== undefined && parseInt(data.duration) > 0) {
          payload['override-duration-minutes'] = parseInt(data.duration);
        }

        if (!isNonEmptyString(data.reasonDisplay)) {
          throw new Error("Loop notification failed: 'reasonDisplay' is required for Temporary Override.");
        }
        alert = `${data.reasonDisplay} Temporary Override`;
      } else if (data.eventType === 'Remote Carbs Entry') {
        const carbsEntry = parseFloat(data.remoteCarbs);
        if (isNaN(carbsEntry) || carbsEntry <= 0) {
          throw new Error(`Loop remote carbs failed. Incorrect carbs entry: ${data.remoteCarbs}`);
        }
        payload['carbs-entry'] = carbsEntry;

        let absorptionTime = 3.0; // Default absorption time
        if (data.remoteAbsorption !== undefined) {
          const absorption = parseFloat(data.remoteAbsorption);
          if (!isNaN(absorption) && absorption > 0) {
            absorptionTime = absorption;
          }
        }
        payload['absorption-time'] = absorptionTime;

        if (isNonEmptyString(data.otp)) {
          payload['otp'] = data.otp;
        }

        if (isNonEmptyString(data.created_at)) {
          payload['start-time'] = data.created_at;
        }

        alert = `Remote Carbs Entry: ${payload['carbs-entry']} grams\n`;
        alert += `Absorption Time: ${payload['absorption-time']} hours`;
      } else if (data.eventType === 'Remote Bolus Entry') {
        const bolusEntry = parseFloat(data.remoteBolus);
        if (isNaN(bolusEntry) || bolusEntry <= 0) {
          throw new Error(`Loop remote bolus failed. Incorrect bolus entry: ${data.remoteBolus}`);
        }
        payload['bolus-entry'] = bolusEntry;

        if (isNonEmptyString(data.otp)) {
          payload['otp'] = data.otp;
        }

        alert = `Remote Bolus Entry: ${payload['bolus-entry']} U\n`;
      } else {
        throw new Error(`Loop notification failed: Unhandled or missing event type: ${data.eventType}`);
      }

      if (isNonEmptyString(data.notes)) {
        payload.notes = data.notes;
        alert += ` - ${data.notes}`;
      }

      if (isNonEmptyString(data.enteredBy)) {
        payload['entered-by'] = data.enteredBy;
        alert += ` - ${data.enteredBy}`;
      }

      // Track time notification was sent
      const now = new Date();
      payload['sent-at'] = now.toISOString();

      // Expire after 5 minutes
      const expiration = new Date(now.getTime() + 5 * 60 * 1000);
      payload['expiration'] = expiration.toISOString();

      // Create notification
      const notification = new apn.Notification();
      notification.alert = alert;
      notification.topic = loopSettings.bundleIdentifier;
      notification.contentAvailable = 1;
      notification.payload = payload;
      notification.interruptionLevel = 'time-sensitive';
      notification.expiry = Math.floor(expiration.getTime() / 1000); // Set expiry time in seconds

      // Send notification
      const response = await provider.send(notification, [loopSettings.deviceToken]);

      if (response.sent && response.sent.length > 0) {
        console.log('Notification accepted by APNs:', response.sent);
        safeCompletion(null, 'Notification was successfully accepted by APNs.');
      } else {
        console.error('Notification rejected by APNs:', response.failed);
        response.failed.forEach((failure) => {
          const deviceToken = failure.device;
          const status = failure.status;
          const reason = failure.response?.reason || 'Unknown reason';
          console.error(`Notification to device ${deviceToken} failed with status ${status}: ${reason}`);
        });
        const errorMessage = `APNs delivery failed: ${response.failed[0]?.response?.reason || 'Unknown reason'}`;
        safeCompletion(errorMessage);
      }
    } catch (error) {
      console.error('Error in sendNotification:', error);
      safeCompletion(error.message || 'Unknown error');
    } finally {
      if (provider) {
        provider.shutdown();
      }
    }
  };

  return loop();
}

module.exports = init;

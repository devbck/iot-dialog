/**
 * Copyright 2016 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*eslint-env node, express*/
'use strict';

var express  = require('express'),
  app        = express(),
  fs         = require('fs'),
  path       = require('path'),
  bluemix    = require('./config/bluemix'),
  extend     = require('util')._extend,
  watson     = require('watson-developer-cloud'),
  ibmiotf    = require('ibmiotf');

// Bootstrap application settings
require('./config/express')(app);

// 
// Set crredentials and service wrappers for Watson Dialog service
// - if credentials for Watson Dialog service exists, then override local
// - set dialog service wrapper
// - set dialog ID
//
var credentials =  extend({
  url: 'https://gateway.watsonplatform.net/dialog/api',
  "password": "xxxxxxxx",
  "username": "xxxxxxxxxxxxxxxx",
  version: 'v1'
}, bluemix.getServiceCreds('dialog')); // VCAP_SERVICES
// Create the service wrapper
var dialog = watson.dialog(credentials);
var dialog_id_in_json = (function() {
  try {
    var dialogsFile = path.join(path.dirname(__filename), 'dialogs', 'dialog-id.json');
    var obj = JSON.parse(fs.readFileSync(dialogsFile));
    return obj[Object.keys(obj)[0]].id;
  } catch (e) {
  }
})();

var dialog_id = process.env.DIALOG_ID || dialog_id_in_json|| "bbe01ff1-296e-48cc-a38c-e96f046a6bcf";

// 
// Create application client for Watson IoTP service 
// - If credentials for Watson IoT Platform service exists, then override local
//
var iotCredentials = extend({
  org: 'xxxxx',
  id: ''+Date.now(),
  "auth-key": 'a-xxxxx-ja0xe12jro',
  "auth-token": 'xxxxxxxxxxxx'
}, bluemix.getIoTServiceCreds());
var appClient = new ibmiotf.IotfApplication(iotCredentials);


// Variables used for Dialog and WIoTP service interaction
var DISPLAY_SENSOR_VALUE = "DISPLAY SENSOR VALUE";
var DISPLAY_NO_DEVICE = "DISPLAY NO DEVICE";
//IoT devices map
var devices = {};

//
// Invoke POST method to converse with dialog service
// 
app.post('/conversation', function(req, res, next) {
  var params = extend({ dialog_id: dialog_id }, req.body);
  dialog.conversation(params, function(err, results) {
    console.log("results : "+JSON.stringify(results));
    var resultStr = results.response.join(' ');
    if (err){
      return next(err);
    } // Check if to return the list of devices based on the response of dialog service
    else if(resultStr.indexOf('could be in one of the following office(s)') !== -1 || 
              resultStr.indexOf('here are the list of offices') !== -1) {
      // 
      // Use WIoTP application client to connect to WIoTP service and get data of all devices.
      //
      appClient
      .getAllDevices().then (function onSuccess (argument) {
        console.log("Success");
        console.log(argument);
        var deviceResults = argument.results;
        //
        // Add all IoT devices in an array. The index of the array is the Metadata
        // set in during device creation/update in Watson IoT Platform service
        //
        devices = {};
        deviceResults.forEach(function (device) {
          var id = device.deviceId;
          //Get the content from the device Metadata
          if(device.metadata && device.metadata['Office Number']){
            id = device.metadata['Office Number'];
          }
          //store the device data
          devices[id] = device;
        });
        //return the response of list of devices
        results.response = Object.keys(devices);
        results.response.unshift(resultStr);
        res.json({ dialog_id: dialog_id, conversation: results});

      }, function onError (argument) {
        //
        // the Watson IoT service is not bound.
        //
        console.log("Fail");
        console.log(argument);
        results.response.push("");
        results.response.push("Bind the Watson IoT Service to get the list of Rooms");
        res.json({ dialog_id: dialog_id, conversation: results});
      });
    } //Check if to get the device last event from the dialog response
    else if(getDeviceValue(resultStr)) {
      var device = resultStr.split(',')[0];
      var selected = devices[device];
      //User has entered a non existent device name, return device not found
      if(selected === undefined){
        var params = extend({ dialog_id: dialog_id }, req.body);
          params.input = DISPLAY_NO_DEVICE;
          dialog.conversation(params, function(err, results) {
            if (err) {
              return next(err);
            } 
            
            res.json({ dialog_id: dialog_id, conversation: results});

          });
      } else {
        //
        //Get the last event of the device using the Last event cache from Waston IoT service(https://docs.internetofthings.ibmcloud.com/swagger/v0002.html#!/Event_Cache)
        //
        appClient
          .getLastEvents(selected.typeId, selected.deviceId).then (function onSuccess (argument) {
           
            var value = "";
            if(argument !== undefined && argument[0] !== undefined) {
              try { //read the payload and try to parse the content
                  var payload = JSON.parse(new Buffer(argument[0].payload, 'base64').toString('ascii'));
                  console.log("Payload is : "+JSON.stringify(payload));
                  // read the datapoint value
                  var datapointName = "temperature";
                  
                  // Fetch the value from the sensor.
                  /*
                  format of data
                  { "temperature" : 34}
                  OR
                  { "d" : { "temperature" : 43}  }
                  */
                  var datapointValue = payload[datapointName] || payload.d[datapointName];

                  if(datapointValue !== undefined && datapointValue !== null) {
                    value = datapointValue;
                  } else { // data point not found. Return error
                    value = "NO";
                  }
              } catch(e) {
                console.log("Fail : "+e);
                value = "NO";
              }

            } else 
              value = "NO";
            //  
            // update the dialog profile with datapoint "value" so that it can be returned as part of dialog response
            //
            var profile = {
              client_id: req.body.client_id,
              dialog_id: dialog_id,
              name_values: [
                { name:'value', value: value }
              ]
            }; 
            dialog.updateProfile(profile, function(err, results) {
              if (err)
                return next(err);
              
              // 
              // Call dialog api to get the latest last conversation value
              //
              var param = extend({ dialog_id: dialog_id }, req.body);
              param.input = DISPLAY_SENSOR_VALUE;
              dialog.conversation(param, function(err, results) {
                if (err){
                  return next(err);
                } 
                
                //
                // ------------------------------------------------------------------
                // Part 2 of the recipe -------
                // Uncomment next two statements to validate temperature
                // ------------------------------------------------------------------
                //
                
                /* 
                var validateMessage = validateTemp(value);
                results.response[0]+=validateMessage; 
                */
               
                res.json({ dialog_id: dialog_id, conversation: results});
              });
            });
          }, function onError (argument) {
            
            console.log("Fail");
            console.log(argument);
        });
      }
    }
    else
      res.json({ dialog_id: dialog_id, conversation: results});
  });
});

app.post('/profile', function(req, res, next) {
  var params = extend({ dialog_id: dialog_id }, req.body);
  dialog.getProfile(params, function(err, results) {
    if (err)
      return next(err);

    res.json(results);
  });
});

// error-handler settings
require('./config/error-handler')(app);

var port = process.env.VCAP_APP_PORT || 3001;
app.listen(port);
console.log('listening at:', port);

//return the value of the sensor
function getDeviceValue(results) {
  return results.indexOf('VALUE') !== -1;
}


//
// ------------------------------------------------------------------
// Part 2 of the recipe -------
// Uncommecnt the following statements to validate temperature
// - This function is a example of "how to set dialog response to
//   the user from the application"
// ------------------------------------------------------------------
//
                
/*
var MINIMUM_TEMP = 19;
var MAXIMUM_TEMP = 25;

function validateTemp(temperature) {
  
  if(temperature < MINIMUM_TEMP) {
    return " The temperature is getting cold right now.  I will turn on the heat for you..";
  } else if(temperature > MAXIMUM_TEMP){
    return " The temperature is getting hot.  I will turn on the air conditioning for you.";
  } else {
    return " This temperature should be nice and comfortable.. ";
  }
}*/

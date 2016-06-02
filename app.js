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

//for conversing with the dialog service
var DISPLAY_SENSOR_VALUE = "DISPLAY SENSOR VALUE";
var DISPLAY_NO_DEVICE = "DISPLAY NO DEVICE";

// if bluemix credentials exists, then override local
var credentials =  extend({
  url: 'https://gateway.watsonplatform.net/dialog/api',
  "password": "xxxx",
  "username": "xxxx",
  version: 'v1'
}, bluemix.getServiceCreds('dialog')); // VCAP_SERVICES

// if bluemix credentials exists, then override local
var iotCredentials = extend({
  org: 'xxxx',
  id: ''+Date.now(),
  "auth-key": 'a-xxxx-ja0xe12jro',
  "auth-token": 'xxxx'
}, bluemix.getIoTServiceCreds());


var dialog_id_in_json = (function() {
  try {
    var dialogsFile = path.join(path.dirname(__filename), 'dialogs', 'dialog-id.json');
    var obj = JSON.parse(fs.readFileSync(dialogsFile));
    return obj[Object.keys(obj)[0]].id;
  } catch (e) {
  }
})();

//Watson IoT devices
var devices = {};
//device events
var temps;

var appClient = new ibmiotf.IotfApplication(iotCredentials);

// Create the service wrapper
var dialog = watson.dialog(credentials);

var dialog_id = process.env.DIALOG_ID || dialog_id_in_json;

//create the dialog
/*var fullPath = "./dialogs/temp.xml";
var params = {
  dialog_id : dialog_id,
  file : fs.createReadStream(fullPath)
};

dialog.updateDialog(params, function(error, response, body) {

  console.log("resp  : "+JSON.stringify(response));
  console.log("error  : "+error);
  console.log("body  : "+JSON.stringify(body));
});*/

app.post('/conversation', function(req, res, next) {
  var params = extend({ dialog_id: dialog_id }, req.body);
  dialog.conversation(params, function(err, results) {
    console.log("results : "+JSON.stringify(results));
    var resultStr = results.response.join(' ');
    if (err){
      return next(err);
    }
    else if(getDevices(resultStr)) {
      appClient
      .getAllDevices().then (function onSuccess (argument) {
        console.log("Success");
        console.log(argument);
        var deviceResults = argument.results;
        devices = {};
        deviceResults.forEach(function (device) {
          var id = device.deviceId;
          if(device.metadata && device.metadata['Office Number']){
            id = device.metadata['Office Number'];
          }
          devices[id] = device;
        });
        results.response = Object.keys(devices);
        results.response.unshift(resultStr);
        res.json({ dialog_id: dialog_id, conversation: results});

      }, function onError (argument) {
        
        console.log("Fail");
        console.log(argument);
        results.response.push("");
        results.response.push("Bind the Watson IoT Service to get the list of Rooms");
        res.json({ dialog_id: dialog_id, conversation: results});
      });
    } 
    else if(getDeviceValue(resultStr)) {
      var device = resultStr.split(',')[0];
      var selected = devices[device];
      
      if(selected === undefined){
        var params = extend({ dialog_id: dialog_id }, req.body);
          params.input = DISPLAY_NO_DEVICE;
          dialog.conversation(params, function(err, results) {
            if (err){
              return next(err);
            } 
            else {
              res.json({ dialog_id: dialog_id, conversation: results});
            }
          });
      } else {
        appClient
          .getLastEvents(selected.typeId, selected.deviceId).then (function onSuccess (argument) {
           
            var value = "";
            if(argument !== undefined && argument[0] !== undefined) {
              try {
                  var payload = JSON.parse(new Buffer(argument[0].payload, 'base64').toString('ascii'));
                  console.log("Payload is : "+JSON.stringify(payload));
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
                  } else {
                    value = "NO";
                  }
              } catch(e) {
                console.log("Fail : "+e);
                value = "NO";
              }

            } else 
              value = "NO";

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
              
              //call the converse api to get the latest value
              var params = extend({ dialog_id: dialog_id }, req.body);
              params.input = DISPLAY_SENSOR_VALUE;
              dialog.conversation(params, function(err, results) {
                if (err){
                  return next(err);
                } 
                //UNCOMMENT HERE for validate temperature
                /*var validateMessage = validateTemp(value);
                results.response[0]+=validateMessage;*/
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
    else
      res.json(results);
  });
});

// error-handler settings
require('./config/error-handler')(app);

var port = process.env.VCAP_APP_PORT || 3001;
app.listen(port);
console.log('listening at:', port);

//return Devices
function getDevices(results) {
  return results.indexOf('one of the following offices') !== -1;
}

//return the value of the sensor
function getDeviceValue(results) {
  return results.indexOf('VALUE') !== -1;
}

//UNCOMMENT HERE for validate temperature
/*var MINIMUM_TEMP = 70;
var MAXIMUM_TEMP = 80;

function validateTemp(temperature) {
  
  if(temperature < MINIMUM_TEMP) {
    return "This temperature is below the comfortable limit of "+MINIMUM_TEMP+" - "+MAXIMUM_TEMP+" degree Fahrenheit. Increase the temperature of your room."
  } else if(temperature > MAXIMUM_TEMP){
    return "This temperature is above the comfortable limit of "+MINIMUM_TEMP+" - "+MAXIMUM_TEMP+" degree Fahrenheit. Decrease the temperature of your room."
  } else {
    return "This temperature is in the comfortable limit of "+MINIMUM_TEMP+" - "+MAXIMUM_TEMP+" degree Fahrenheit. "
  }
}*/
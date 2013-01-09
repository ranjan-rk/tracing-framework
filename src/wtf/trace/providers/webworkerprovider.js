/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Web Worker event provider.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.trace.providers.WebWorkerProvider');

goog.require('goog.Uri');
goog.require('goog.array');
goog.require('goog.result.SimpleResult');
goog.require('wtf.trace');
goog.require('wtf.trace.Provider');
goog.require('wtf.trace.events');
goog.require('wtf.trace.eventtarget');
goog.require('wtf.trace.eventtarget.BaseEventTarget');
goog.require('wtf.trace.util');



/**
 * Provides Web Worker API events.
 *
 * @param {!wtf.util.Options} options Options.
 * @constructor
 * @extends {wtf.trace.Provider}
 */
wtf.trace.providers.WebWorkerProvider = function(options) {
  goog.base(this, options);

  var level = options.getNumber('wtf.trace.provider.webworker', 1);
  if (!level) {
    return;
  }

  // TODO(benvanik): use weak references (WeakMap) when supported.
  /**
   * All active child workers.
   * @type {!Array.<!Object>}
   * @private
   */
  this.childWorkers_ = [];

  // TODO(benvanik): read wtf.trace.provider.webworker.inject to choose
  //     injection behavior.

  // Since workers will eventually be available within workers we test for them.
  if (typeof goog.global['Worker'] == 'function') {
    this.injectBrowserShim_();
  }

  // Nasty test - assume we aren't Node.
  if (!goog.global['HTMLDivElement']) {
    this.injectProxyWorker_();
  }

  // TODO(benvanik): async snapshot API
  // goog.global['snapshotworkers'] = goog.bind(function() {
  //   var results = [];
  //   for (var n = 0; n < this.childWorkers_.length; n++) {
  //     var worker = this.childWorkers_[n];
  //     results.push(worker.requestSnapshot());
  //   }
  //   return goog.result.combine.apply(null, results);
  // }, this);
};
goog.inherits(wtf.trace.providers.WebWorkerProvider, wtf.trace.Provider);


/**
 * @override
 */
wtf.trace.providers.WebWorkerProvider.prototype.getSettingsSectionConfigs =
    function() {
  return [
    {
      'title': 'Web Workers',
      'widgets': [
        {
          'type': 'checkbox',
          'key': 'wtf.trace.provider.webworker',
          'title': 'Enabled',
          'default': true
        },
        {
          'type': 'checkbox',
          'key': 'wtf.trace.provider.webworker.inject',
          'title': 'Auto Inject in to Workers',
          'default': true
        }
      ]
    }
  ];
};


/**
 * Injects worker constructor shims.
 * @private
 */
wtf.trace.providers.WebWorkerProvider.prototype.injectBrowserShim_ =
    function() {
  var provider = this;

  // TODO(benvanik): add flow ID tracking code

  var originalWorker = goog.global['Worker'];
  var prefix = 'Worker';

  var descriptor = wtf.trace.eventtarget.createDescriptor('Worker', [
    'error',
    'message'
  ]);

  // Get WTF URL.
  var wtfUrl = wtf.trace.util.getScriptUrl();
  var baseUri = new goog.Uri(goog.global.location.href);

  var nextWorkerId = 0;
  var workerCtorEvent = wtf.trace.events.createScope(
      'Worker(ascii scriptUrl, uint32 id)');

  /**
   * Worker shim.
   * @param {string} scriptUrl Script URL.
   * @constructor
   * @extends {wtf.trace.eventtarget.BaseEventTarget}
   */
  var ProxyWorker = function(scriptUrl) {
    goog.base(this, descriptor);

    /**
     * Script URL.
     * @type {string}
     * @private
     */
    this.scriptUrl_ = scriptUrl;

    /**
     * Tracking ID.
     * @type {number}
     * @private
     */
    this.workerId_ = nextWorkerId++;

    var resolvedScriptUrl = goog.Uri.resolve(baseUri, scriptUrl).toString();

    var shimScript = [
      'this.WTF_WORKER_ID = ' + this.workerId_ + ';',
      'this.WTF_WORKER_BASE_URI = "' + goog.global.location.href + '";',
      'importScripts("' + wtfUrl + '");',
      'wtf.trace.prepare({',
      '});',
      'wtf.trace.start();',
      'importScripts("' + resolvedScriptUrl + '");'
    ].join('\n');
    var shimBlob = new Blob([shimScript], {
      'type': 'text/javascript'
    });
    var shimScriptUrl = goog.global['URL'] ?
        goog.global['URL'].createObjectURL(shimBlob) :
        goog.global['webkitURL'].createObjectURL(shimBlob);

    var scope = workerCtorEvent(scriptUrl, this.workerId_);
    var handle;
    try {
      handle = new originalWorker(shimScriptUrl);
    } finally {
      wtf.trace.leaveScope(scope);
    }

    /**
     * Handle to the underlying worker instance.
     * @type {!Worker}
     * @private
     */
    this.handle_ = handle;

    /**
     * Event type trackers, by name.
     * @type {!Object.<Function>}
     * @private
     */
    this.trackers_ = {};

    this.setEventHook('error', function(e) {
      wtf.trace.appendScopeData('id', this.workerId_);
    }, this);
    this.setEventHook('message', function(e) {
      wtf.trace.appendScopeData('id', this.workerId_);
    }, this);

    // Always hook onmessage.
    // By doing it here we get first access to the event.
    var self = this;
    this.handle_.addEventListener('message', function(e) {
      // Sniff provider messages.
      if (e.data['__wtf_worker_msg__']) {
        var value = e.data['value'];
        switch (e.data['command']) {
          case 'snapshot':
            var result = pendingSnapshots[value['id']];
            delete pendingSnapshots[value['id']];
            if (!result.getError()) {
              result.setValue(value['data']);
            }
            break;
          case 'close':
            goog.array.remove(provider.childWorkers_, self);
            break;
        }
        return;
      }
    }, false);

    provider.childWorkers_.push(this);
  };
  goog.inherits(ProxyWorker, wtf.trace.eventtarget.BaseEventTarget);

  // Event tracking.
  ProxyWorker.prototype.beginTrackingEvent = function(type) {
    var self = this;
    var tracker = function(e) {
      self['dispatchEvent'](e);
    };
    this.trackers_[type] = tracker;
    this.handle_.addEventListener(type, tracker, false);
  };
  ProxyWorker.prototype.endTrackingEvent = function(type) {
    this.handle_.removeEventListener(type, this.trackers_[type], false);
    delete this.trackers_[type];
  };

  // Setup on* events.
  var eventInfos = descriptor.eventInfos;
  for (var n = 0; n < eventInfos.length; n++) {
    var eventInfo = eventInfos[n];
    Object.defineProperty(ProxyWorker.prototype,
        'on' + eventInfo.name, {
          'configurable': false,
          'enumerable': false,
          'get': eventInfo.getter,
          'set': eventInfo.setter
        });
  }

  /**
   * Sends an internal message to the worker.
   * @param {string} command Command name.
   * @param {*=} opt_value Command value.
   */
  ProxyWorker.prototype.sendMessage = function(command, opt_value) {
    this.handle_.postMessage({
      '__wtf_worker_msg__': true,
      'command': command,
      'value': opt_value || null
    });
  };

  var postMessageEvent = wtf.trace.events.createScope(
      'Worker#postMessage(uint32 id)');
  ProxyWorker.prototype['postMessage'] = function(message, opt_transfer) {
    var scope = postMessageEvent(this.workerId_);
    try {
      this.handle_.postMessage(message, opt_transfer);
    } finally {
      wtf.trace.leaveScope(scope);
    }
  };

  var terminateEvent = wtf.trace.events.createInstance(
      'Worker#terminate(uint32 id)');
  ProxyWorker.prototype['terminate'] = function() {
    // TODO(benvanik): request a snapshot before terminating?
    goog.array.remove(provider.childWorkers_, this);

    terminateEvent(this.workerId_);
    this.handle_.terminate();
  };

  var pendingSnapshots = {};
  var snapshotRequestId = 0;
  ProxyWorker.prototype.requestSnapshot = function() {
    var result = new goog.result.SimpleResult();
    var snapshotId = snapshotRequestId++;
    pendingSnapshots[snapshotId] = result;
    this.sendMessage('snapshot', {
      'id': snapshotId
    });
    return result;
  };

  this.injectFunction(goog.global, 'Worker', ProxyWorker);
};


/**
 * Injects worker constructor shims.
 * @private
 */
wtf.trace.providers.WebWorkerProvider.prototype.injectProxyWorker_ =
    function() {
  var workerId = goog.global['WTF_WORKER_ID'];
  var baseUri = new goog.Uri(goog.global['WTF_WORKER_BASE_URI']);

  // Mixin addEventListener/etc.
  var globalDescriptor = wtf.trace.eventtarget.createDescriptor(
      'WorkerGlobalScope', [
        'error',
        'online',
        'offline',
        'message'
      ]);
  wtf.trace.eventtarget.mixin(globalDescriptor, goog.global);

  // Setup on* events.
  wtf.trace.eventtarget.setEventProperties(globalDescriptor, goog.global);
  //wtf.trace.eventtarget.initializeEventProperties(goog.global);

  // -- WorkerUtils --

  var originalImportScripts = goog.global.importScripts;
  var importScriptsEvent = wtf.trace.events.createScope(
      'WorkerUtils#importScripts(any urls)');
  this.injectFunction(goog.global, 'importScripts', function(var_args) {
    var urls = new Array(arguments.length);
    for (var n = 0; n < arguments.length; n++) {
      urls[n] = goog.Uri.resolve(baseUri, arguments[n]).toString();
    }
    var scope = importScriptsEvent(urls);
    try {
      return originalImportScripts.apply(goog.global, urls);
    } finally {
      wtf.trace.leaveScope(scope);
    }
  });

  // TODO(benvanik): spoof location with baseUri
  //goog.global['location'] = WorkerLocation;

  // -- WorkerGlobalScope --

  var originalClose = goog.global.close;
  var closeEvent = wtf.trace.events.createInstance(
      'WorkerGlobalScope#close()');
  this.injectFunction(goog.global, 'close', function() {
    closeEvent();
    sendMessage('close');
    originalClose.call(goog.global);
  });

  // TODO(benvanik): onerror - ErrorEvent
  // interface ErrorEvent : Event {
  //   readonly attribute DOMString message;
  //   readonly attribute DOMString filename;
  //   readonly attribute unsigned long lineno;
  //   readonly attribute unsigned long column;
  // };

  // TODO(benvanik): onoffline/ononline

  // -- DedicatedWorkerGlobalScope --

  var originalPostMessage = goog.global.postMessage;
  var postMessageEvent = wtf.trace.events.createScope(
      'DedicatedWorkerGlobalScope#postMessage()');
  this.injectFunction(goog.global, 'postMessage', function(
      message, opt_transfer) {
        var scope = postMessageEvent();
        try {
          originalPostMessage.call(goog.global, message, opt_transfer);
        } finally {
          wtf.trace.leaveScope(scope);
        }
      });

  // TODO(benvanik): DedicatedWorkerGlobalScope#onmessage - MessageEvent
  // interface MessageEvent : Event {
  //   readonly attribute any data;
  //   readonly attribute DOMString origin;
  //   readonly attribute DOMString lastEventId;
  //   readonly attribute (WindowProxy or MessagePort)? source;
  //   readonly attribute MessagePort[]? ports;
  // }
  // TODO(benvanik): fully override the event dispatch.
  goog.global.addEventListener('message', function(e) {
    // Sniff provider messages.
    if (e.data['__wtf_worker_msg__']) {
      var value = e.data['value'];
      switch (e.data['command']) {
        case 'snapshot':
          var data = [];
          wtf.trace.snapshot(data);
          sendMessage('snapshot', {
            'id': value['id'],
            'data': data
          }, data[0]);
          break;
      }
      // This won't be required once we hook dispatch.
      delete e.data['__wtf_worker_msg__'];
      delete e.data['command'];
      delete e.data['value'];
    }
  }, false);

  /**
   * Sends an internal message to the worker.
   * @param {string} command Command name.
   * @param {*=} opt_value Command value.
   * @param {Array=} opt_transfer Transferrable values.
   */
  function sendMessage(command, opt_value, opt_transfer) {
    // TODO(benvanik): attempt to use webkitPostMessage
    originalPostMessage.call(goog.global, {
      '__wtf_worker_msg__': true,
      'command': command,
      'value': opt_value || null
    }, []);
  };
};

"use strict";

var inherits = require('util').inherits
  , f = require('util').format
  , toError = require('./utils').toError
  , getSingleProperty = require('./utils').getSingleProperty
  , formattedOrderClause = require('./utils').formattedOrderClause
  , handleCallback = require('./utils').handleCallback
  , Logger = require('mongodb-core').Logger
  , EventEmitter = require('events').EventEmitter
  , ReadPreference = require('./read_preference')
  , MongoError = require('mongodb-core').MongoError
  , Readable = require('stream').Readable || require('readable-stream').Readable
  // , CoreCursor = require('mongodb-core').Cursor
  , CoreCursor = require('./cursor')
  , Query = require('mongodb-core').Query
  , CoreReadPreference = require('mongodb-core').ReadPreference;

/**
 * @fileOverview The **CommandCursor** class is an internal class that embodies a 
 * generalized cursor based on a MongoDB command allowing for iteration over the 
 * results returned. It supports one by one document iteration, conversion to an 
 * array or can be iterated as a Node 0.10.X or higher stream
 * 
 * **CommandCursor Cannot directly be instantiated**
 * @example
 * var MongoClient = require('mongodb').MongoClient,
 *   test = require('assert');
 * // Connection url
 * var url = 'mongodb://localhost:27017/test';
 * // Connect using MongoClient
 * MongoClient.connect(url, function(err, db) {
 *   // Create a collection we want to drop later
 *   var col = db.collection('listCollectionsExample1');
 *   // Insert a bunch of documents
 *   col.insert([{a:1, b:1}
 *     , {a:2, b:2}, {a:3, b:3}
 *     , {a:4, b:4}], {w:1}, function(err, result) {
 *     test.equal(null, err);
 * 
 *     // List the database collections available
 *     db.listCollections().toArray(function(err, items) {
 *       test.equal(null, err);
 *       db.close();
 *     });
 *   });
 * });
 */

/**
 * Namespace provided by the browser.
 * @external Readable
 */

/**
 * Creates a new Command Cursor instance (INTERNAL TYPE, do not instantiate directly)
 * @class CommandCursor
 * @extends external:Readable
 * @fires CommandCursor#data
 * @fires CommandCursor#end
 * @fires CommandCursor#close
 * @fires CommandCursor#readable
 * @return {CommandCursor} an CommandCursor instance.
 */
var CommandCursor = function(bson, ns, cmd, options, topology, topologyOptions) {
  CoreCursor.apply(this, Array.prototype.slice.call(arguments, 0));
  var self = this;
  var state = CommandCursor.INIT;
  var streamOptions = {};

  // MaxTimeMS
  var maxTimeMS = null;

  // Set up
  Readable.call(this, {objectMode: true});

  // Internal state
  this.s = {
    // MaxTimeMS
      maxTimeMS: maxTimeMS
    // State
    , state: state
    // Stream options
    , streamOptions: streamOptions
    // BSON
    , bson: bson
    // Namespae
    , ns: ns
    // Command
    , cmd: cmd
    // Options
    , options: options
    // Topology
    , topology: topology
    // Topology Options
    , topologyOptions: topologyOptions
  }
}

/**
 * CommandCursor stream data event, fired for each document in the cursor.
 *
 * @event CommandCursor#data
 * @type {object}
 */

/**
 * CommandCursor stream end event
 *
 * @event CommandCursor#end
 * @type {null}
 */

/**
 * CommandCursor stream close event
 *
 * @event CommandCursor#close
 * @type {null}
 */

/**
 * CommandCursor stream readable event
 *
 * @event CommandCursor#readable
 * @type {null}
 */

// Inherit from Readable
inherits(CommandCursor, Readable);  

// Set the methods to inherit from prototype
var methodsToInherit = ['_next', 'next', 'each', 'forEach', 'toArray'
  , 'rewind', 'bufferedCount', 'readBufferedDocuments', 'close', 'isClosed'];

// Only inherit the types we need
for(var i = 0; i < methodsToInherit.length; i++) {
  CommandCursor.prototype[methodsToInherit[i]] = CoreCursor.prototype[methodsToInherit[i]];
}

/**
 * Set the batch size for the cursor.
 * @method
 * @param {number} value The batchSize for the cursor.
 * @throws {MongoError}
 * @return {CommandCursor}
 */
CommandCursor.prototype.batchSize = function(value) {
  if(this.s.state == CommandCursor.CLOSED || this.isDead()) throw new MongoError("Cursor is closed");
  if(typeof value != 'number') throw new MongoError("batchSize requires an integer");
  if(this.s.cmd.cursor) this.s.cmd.cursor.batchSize = value;
  this.setCursorBatchSize(value);
  return this;
}

/**
 * Add a maxTimeMS stage to the aggregation pipeline
 * @method
 * @param {number} value The state maxTimeMS value.
 * @return {CommandCursor}
 */
CommandCursor.prototype.maxTimeMS = function(value) {
  if(this.s.topology.lastIsMaster().minWireVersion > 2) {
    this.s.cmd.maxTimeMS = value;
  }
  return this;
}

CommandCursor.prototype.get = CommandCursor.prototype.toArray;

/**
 * Get the next available document from the cursor, returns null if no more documents are available.
 * @function CommandCursor.prototype.next
 * @param {CommandCursor~resultCallback} callback The result callback.
 * @throws {MongoError}
 * @return {null}
 */

/**
 * Set the new batchSize of the cursor
 * @function CommandCursor.prototype.setBatchSize
 * @param {number} value The new batchSize for the cursor
 * @return {null}
 */

/**
 * Get the batchSize of the cursor
 * @function CommandCursor.prototype.batchSize
 * @param {number} value The current batchSize for the cursor
 * @return {null}
 */

/**
 * The callback format for results
 * @callback CommandCursor~toArrayResultCallback
 * @param {MongoError} error An error instance representing the error during the execution.
 * @param {object[]} documents All the documents the satisfy the cursor.
 */

/**
 * Returns an array of documents. The caller is responsible for making sure that there
 * is enough memory to store the results. Note that the array only contain partial
 * results when this cursor had been previouly accessed.
 * @method CommandCursor.prototype.toArray
 * @param {CommandCursor~toArrayResultCallback} callback The result callback.
 * @throws {MongoError}
 * @return {null}
 */

/**
 * The callback format for results
 * @callback CommandCursor~resultCallback
 * @param {MongoError} error An error instance representing the error during the execution.
 * @param {(object|null)} result The result object if the command was executed successfully.
 */

/**
 * Iterates over all the documents for this cursor. As with **{cursor.toArray}**,
 * not all of the elements will be iterated if this cursor had been previouly accessed.
 * In that case, **{cursor.rewind}** can be used to reset the cursor. However, unlike
 * **{cursor.toArray}**, the cursor will only hold a maximum of batch size elements
 * at any given time if batch size is specified. Otherwise, the caller is responsible
 * for making sure that the entire result can fit the memory.
 * @method CommandCursor.prototype.each
 * @param {CommandCursor~resultCallback} callback The result callback.
 * @throws {MongoError}
 * @return {null}
 */

/**
 * Close the cursor, sending a KillCursor command and emitting close.
 * @method CommandCursor.prototype.close
 * @param {CommandCursor~resultCallback} [callback] The result callback.
 * @return {null}
 */   

/**
 * Is the cursor closed
 * @method CommandCursor.prototype.isClosed
 * @return {boolean}
 */   

/**
 * Clone the cursor
 * @function CommandCursor.prototype.clone
 * @return {CommandCursor}
 */     

/**
 * Resets the cursor
 * @function CommandCursor.prototype.rewind
 * @return {CommandCursor}
 */  

/**
 * The callback format for the forEach iterator method
 * @callback CommandCursor~iteratorCallback
 * @param {Object} doc An emitted document for the iterator
 */

/**
 * The callback error format for the forEach iterator method
 * @callback CommandCursor~endCallback
 * @param {MongoError} error An error instance representing the error during the execution.
 */

/*
 * Iterates over all the documents for this cursor using the iterator, callback pattern.
 * @method CommandCursor.prototype.forEach
 * @param {CommandCursor~iteratorCallback} iterator The iteration callback.
 * @param {CommandCursor~endCallback} callback The end callback.
 * @throws {MongoError}
 * @return {null}
 */

CommandCursor.INIT = 0;
CommandCursor.OPEN = 1;
CommandCursor.CLOSED = 2;

module.exports = CommandCursor;
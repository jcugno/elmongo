var request = require('request'),
    mongoose = require('mongoose'),
    util = require('util'),
    url = require('url'),
    helpers = require('./helpers'),
    sync = require('./sync')

// turn off request pooling
request.defaults({ agent:false })

// cache elasticsearch url options for elmongo.search() to use
var elasticUrlOptions = null

/**
 * Attach mongoose plugin for elasticsearch indexing
 *
 * @param  {Object} schema      mongoose schema
 * @param  {Object} options     elasticsearch options object. Keys: host, port, index, type
 */
module.exports = elmongo = function (schema, options) {

    var indexedFields = getIndexedFields(schema);

    // attach methods to schema
    schema.methods.index = index
    schema.methods.unindex = unindex

    schema.statics.sync = function (cb) {
        options = helpers.mergeModelOptions(options, this)
        options.indexedFields = indexedFields;

        return sync.call(this, schema, options, cb)
    }

    schema.statics.search = function (searchOpts, cb) {
        options = helpers.mergeModelOptions(options, this)

        var searchUri = helpers.makeTypeUri(options) + '/_search?search_type=dfs_query_then_fetch&preference=_primary_first'

        return helpers.doSearchAndNormalizeResults(searchUri, searchOpts, cb)
    }

    // attach mongoose middleware hooks
    schema.post('save', function () {
        options = helpers.mergeModelOptions(options, this)
        options.indexedFields = indexedFields;
        this.index(options)
    })
    schema.post('remove', function () {
        options = helpers.mergeModelOptions(options, this)
        this.unindex(options)
    })

    // Allowing a model to directly remove itself from an index. Useful if
    // you are using a 'delete' type of flag on a model and not physically removing it
    schema.methods.deleteFromIndex = function() {
        options = helpers.mergeModelOptions(options, this)
        this.unindex(options)
    };

}

/**
 * Search across multiple collections. Same usage as model search, but with an extra key on `searchOpts` - `collections`
 * @param  {Object}   searchOpts
 * @param  {Function} cb
 */
elmongo.search = function (searchOpts, cb) {
    // merge elasticsearch url config options
    elasticUrlOptions = helpers.mergeOptions(elasticUrlOptions)

    // determine collections to search on
    var collections = searchOpts.collections;

    if (elasticUrlOptions.prefix) {
        // prefix was specified - namespace the index names to use the prefix for each collection's index

        if (searchOpts.collections && searchOpts.collections.length) {
            // collections were specified - prepend the prefix on each collection name
            collections = collections.map(function (collection) {
                return elasticUrlOptions.prefix + '-' + collection
            })
        } else {
            // no collections specified, but prefix specified - use wildcard index with prefix
            collections = [ elasticUrlOptions.prefix + '*' ]
        }
    } else {
        // no prefix used

        // if collections specified, just use their names without the prefix

        if (!collections) {
            // no collections were specified so use _all (searches all collections), without prefix
            searchOpts.collections = [ '_all' ]
        }
    }

    var searchUri = helpers.makeDomainUri(elasticUrlOptions) + '/' + collections.join(',') + '/_search?search_type=dfs_query_then_fetch&preference=_primary_first'

    return helpers.doSearchAndNormalizeResults(searchUri, searchOpts, cb)
}

/**
 * Configure the Elasticsearch url options for `elmongo.search()`.
 *
 * @param  {Object} options - keys: host, port, prefix (optional)
 */
elmongo.search.config = function (options) {
    // only overwrite `options` values that are being specified in this call to `config`
    if (elasticUrlOptions) {
        Object
        .keys(elasticUrlOptions)
        .forEach(function (key) {
            elasticUrlOptions[key] = options[key] || elasticUrlOptions[key]
        })
    }
    // normalize the `options` object
    elasticUrlOptions = helpers.mergeOptions(options)
}

/**
 * Index a document in elasticsearch (create if not existing)
 *
 * @param  {Object} options     elasticsearch options object. Keys: host, port, index, type
 */
function index (options) {
    var self = this
    // strip mongoose-added functions, depopulate any populated fields, and serialize the doc
    var esearchDoc = helpers.serializeModel(this, options.indexedFields)

    var indexUri = helpers.makeDocumentUri(options, self)

    var reqOpts = {
        method: 'PUT',
        url: indexUri,
        body: JSON.stringify(esearchDoc)
    }

    // console.log('index:', indexUri)

    helpers.backOffRequest(reqOpts, function (err, res, body) {
        if (err) {
            var error = new Error('Elasticsearch document indexing error: '+util.inspect(err, true, 10, true))
            error.details = err

            self.emit('error', error)
            return
        }

        self.emit('elmongo-indexed', body)
    })
}

/**
 * Remove a document from elasticsearch
 *
 * @param  {Object} options     elasticsearch options object. Keys: host, port, index, type
 */
function unindex (options) {
    var self = this

    var unindexUri = helpers.makeDocumentUri(options, self)

    // console.log('unindex:', unindexUri)

    var reqOpts = {
        method: 'DELETE',
        url: unindexUri
    }

    helpers.backOffRequest(reqOpts, function (err, res, body) {
        if (err) {
            var error = new Error('Elasticsearch document index deletion error: '+util.inspect(err, true, 10, true))
            error.details = err

            self.emit('error', error)
            return
        }

        self.emit('elmongo-unindexed', body)
    })
}


function getIndexedFields(schema){
  var indexedFields = [];
  for(var k in schema.tree){
    if (typeof schema.tree[k] === 'object' && !schema.tree[k].es_no_index) {

      var foundDontIndex = false;
      var keys = Object.keys(schema.tree[k]);
      keys.forEach(function(key) {
        if (schema.tree[k][key].es_no_index) {
          return foundDontIndex = true;
        }
      });

      if (!foundDontIndex) {
        indexedFields.push(k);
      }

    } else if(!schema.tree[k].es_no_index){
      indexedFields.push(k);
    }
  }

  return indexedFields;
}


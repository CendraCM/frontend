var express=require('express');
var app = express();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var parser = require('body-parser');
var session = require('express-session');
var request = require('request');
var config = require('/etc/service-config/service');
var path = require('path');
var fs = require('fs');
var extend = require('extend');
var RedisStore = require('connect-redis')(session);
var Promise = require('promise');
/*var passport = require('passport');
var Strategy = require('passport-openidconnect').Strategy;*/
var issuer = require('openid-client').Issuer;
var yuliIssuer = new issuer(config.issuer);
var oidc = new yuliIssuer.Client(config.creds);

var defaultRequest = request.defaults({baseUrl: config.backend});
var interfaces = {};
/*passport.use(new Strategy(config.oidc,
  function(token, tokenSecret, profile, cb) {
    // In this example, the user's Twitter profile is supplied as the user
    // record.  In a production-quality application, the Twitter profile should
    // be associated with a user record in the application's database, which
    // allows for account linking and authentication with other identity
    // providers.
    new Promise(function(resolve, reject) {
      defaultRequest('/schema?objName=UserInterface', function(error, response, body) {
        if(error) return reject(error);

        try {
          var ui = JSON.parse(body)[0];
        } catch(error) {
          return reject(error);
        }
        resolve(ui);
      });
    })
    .then(function(ui) {
      return new Promise(function(resolve, reject) {
        defaultRequest('/?objInterface='+ui._id+'&externalId='+profile.id, function(error, response, body) {
          if(error) return reject(error);
          try {
            var user = JSON.parse(body)[0];
          } catch(error) {
            return reject(error);
          }
          resolve(user);
        })
      });

    })
    .then(function(user) {
      cb(null, user, profile);
    })
    .catch(function(err) {
      cb(err, false, profile);
    });
  }));

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  done(null, obj);
});*/

app.get('/test', function(req, res, next) {
  res.send('Ok');
});

var sessionConfig = {resave: false, saveUninitialized: false, secret: 'fasñdlfkj2i34u21834udf8u]!!'};
if(config.redis) {
  sessionConfig.store = new RedisStore(config.redis);
}
var sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);
app.use(parser.json());
app.use(parser.urlencoded({extended: true}));
app.use('/bower_components', express.static(path.join(__dirname, 'bower_components')));
app.use('/scripts', express.static(path.join(__dirname, 'app/scripts')));
app.use('/views', express.static(path.join(__dirname, 'app/views')));
app.get('/oidc/callback', function(req, res, next) {
  Promise.all([
    oidc.authorizationCallback(req.protocol+'://'+req.headers.host+'/oidc/callback', req.query)
    .then(function(tokenSet) {
      req.session.tokenSet = tokenSet;
      return oidc.userinfo(tokenSet);
    }),
    new Promise(function(resolve, reject) {
      if(interfaces.UserInterface) return resolve(interfaces.UserInterface);
      defaultRequest('/schema?objName=UserInterface', function(error, response, body) {
        if(error) return reject(error);

        try {
          var ui = JSON.parse(body)[0];
        } catch(error) {
          return reject(error);
        }
        interfaces.UserInterface = ui;
        resolve(ui);
      });
    })
  ])
  .then(function(r) {
    defaultRequest({url: '/?objInterface='+r[1]._id+'&user.externalId='+r[0].sub, headers: {authorization: 'Bearer '+req.session.tokenSet.access_token}}, function(error, response, body) {
      if(error) return res.status(500).send(error);
      try {
        var user = JSON.parse(body)[0];
      } catch(error) {
        return res.status(500).send(error);
      }
      if(!user) {
        req.session.user='anonymous';
        req.session.profile=r[0];
        return res.redirect('/#/notUser');
      }
      req.session.user = user;
      res.redirect('/');
    })
  })
  .catch(function(err) {
    res.status(500).send(err);
  });

  /*passport.authenticate('openidconnect', {callbackURL: "/oidc/callback"}, function(err, user, info) {
    if(err) return res.status(500).send(err);
    if(!user) {
      req.session.user='anonymous';
      req.session.profile=info._json;
      return res.redirect('/#/notUser');
    }
    req.session.user = user._id;
    res.redirect('/');
  })(req, res, next);*/
});
app.use(function(req, res, next) {
  if(!req.session.user) {
    return res.redirect(oidc.authorizationUrl({redirect_uri: req.protocol+'://'+req.headers.host+'/oidc/callback', scope: 'openid'}));
  }
  if(req.session.user == 'anonymous') delete req.session.user;
  next();
}, express.static(path.join(__dirname, 'app')));


app.use(function(req, res, next) {
  console.log(req.method+' '+req.originalUrl+' %j', req.body);
  next();
});

app.use('/backend', function(req, res, next) {
  console.log('%j', config);
  var headers = extend({}, req.headers);
  delete headers.host;
  var options = {
    url: req.url,
    method: req.method,
    headers: headers
  };
  if(["POST", "PUT", "PATCH"].indexOf(req.method) !== -1) {
    options.json = req.body||'';
  }
  console.log('%j', options);
  defaultRequest(options, function(error, response, body) {
    if(error) return res.status(500).send(error);
    res.set(response.headers);
    res.status(response.statusCode).send(body);
  });
});

io.use(function(socket, next) {
  sessionMiddleware(socket.request, socket.request.res, next);
});

io.on('connection', function(socket) {
  var userObj = null;
  var queue = null;
  var tokenSet = null;
  var profile = null;

  if(config.redis) queue = require('redis-event-queue')(config.redis).broadcast;

  var setListeners = function() {
    if(!queue) return;
    queue.removeAllListeners();
    if(!userObj) return;
    new Promise(function(resolve, reject) {
      var options = {
        url: '/schema',
        qs: {
          objName: 'GroupInterface'
        },
        method: 'GET'
      };
      defaultRequest(options, function(error, response, body){
        if(error) return reject(error);
        if(response.statusCode !== 200) return reject(body);
        try {
          resolve(JSON.parse(body)[0]._id);
        } catch(e) {
          reject(e);
        }
      });
    })
    .then(function(schemaId) {
      var options = {
        url: '/',
        qs: {
          objInterface: schemaId,
          "group.objLinks": userObj._id
        },
        method: 'GET'
      };
      return bkRequest(options);
    })
    .then(function(groups) {
      groups.forEach(function(group) {
        var prefix = group.rootGroup?'root':group._id;
        queue.on(prefix+':insert:document', function(doc) {
          socket.emit('document:inserted', doc);
        });
        queue.on(prefix+':update:document', function(doc) {
          socket.emit('document:updated', doc);
        });
        queue.on(prefix+':delete:document', function(doc) {
          socket.emit('document:deleted', doc);
        });
      });
    });
  };

  var isLoggedIn = function() {
    if(userObj && userObj === socket.request.session.user) return true;
    userObj = socket.request.session.user;
    tokenSet = socket.request.session.tokenSet;
    profile = socket.request.session.profile;
    if(userObj) setListeners();
    return !!userObj;
  };

  isLoggedIn();

  var bkRequest = function(options, cb) {
    return new Promise(function(resolve, reject) {
      if(!options.headers) options.headers = {};
      if(!options.headers.authorization && tokenSet) {
        options.headers.authorization = 'Bearer '+tokenSet.access_token;
      }
      defaultRequest(options, function(error, response, body){
        if(error) return reject(error);
        if(response.statusCode >= 400) return reject(body);
        try {
          if(/application\/json/.test(response.headers['content-type']) && typeof body == 'string') {
            body = JSON.parse(body);
          }
          resolve(body);
        } catch(e) {
          reject(e);
        }
      });
    })
    .nodeify(cb);
  };

  var setUserData = function() {
    if(profile) {
      socket.emit('userName:set', profile.name);
    } else if(tokenSet){
      oidc.userinfo(tokenSet)
      .then(function(prof) {
        profile = socket.request.session.profile = prof;
        socket.request.session.save();
        socket.emit('userName:set', profile.name);
      });
    }
    if(userObj.user.baseDirectory) {
      socket.emit('baseDirectory:set', userObj.user.baseDirectory);
    } else {
      var options = {
        url: '/'+userObj._id,
        method: 'GET'
      };
      bkRequest(options, function(err, user) {
        if(err) return socket.emit('error', err);
        if(user) {
          socket.request.session.user = user;
          socket.request.session.save();
          isLoggedIn();
          socket.emit('baseDirectory:set', user.baseDirectory);
        }
      });
    }

  }

  socket.on('nouser:profile', function(cb) {
    cb(socket.request.session.profile);
  });

  socket.on('nouser:create', function(cb) {
    if(!socket.request.session.profile) return cb('No profile found.');
    if(!socket.request.session.tokenSet) return cb('Access Token not found.');
    var mkuser = function() {
      var options = {
        url: '/',
        method: 'POST',
        json: {
          objInterface: [interfaces.UserInterface._id],
          objName: socket.request.session.profile.name.toUpperCase(),
          user: {
            externalId: [socket.request.session.profile.sub]
          }
        },
        headers: {
          authorization: 'Bearer '+tokenSet.access_token
        }
      };
      bkRequest(options, function(err, user) {
        if(user) {
          socket.request.session.user = user;
          socket.request.session.save();
          isLoggedIn();
          setUserData();
        }
        cb(err, user);
      });
    };
    if(!interfaces.UserInterface) {
      var options = {
        url: '/schema',
        qs: {
          objName: 'UserInterface'
        },
        method: 'GET'
      };
      bkRequest(options)
      .then(function(ui) {
        if(!ui[0]) return cb('Could not get UserInterface.');
        interfaces.UserInterface = ui[0];
        mkuser();
      });
    } else {
      mkuser();
    }
  });

  socket.on('insert:document', function(doc, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/',
      json: doc,
      method: 'POST'
    };
    bkRequest(options, cb);
  });

  socket.on('update:document', function(id, doc, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/'+id,
      json: doc,
      method: 'PUT'
    };
    bkRequest(options, cb);
  });

  socket.on('delete:document', function(id, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/'+id,
      method: 'DELETE'
    };
    bkRequest(options, cb);
  });

  socket.on('list:document', function(filter, cb) {
    if(!cb && typeof filter == 'function') {
      cb = filter;
      filter = {};
    }
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/',
      qs: filter,
      method: 'GET'
    };
    bkRequest(options, cb);
  });

  socket.on('get:userData', function(cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    setUserData();
  });

  socket.on('get:document', function(id, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/'+id,
      method: 'GET'
    };
    bkRequest(options, cb);
  });

  socket.on('list:schema', function(filter, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/schema',
      qs: filter,
      method: 'GET'
    };
    bkRequest(options, cb);
  });

  socket.on('get:schema', function(id, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/schema/'+id,
      method: 'GET'
    };
    bkRequest(options, cb);
  });

  socket.on('insert:schema', function(sch, cb) {
    if(!isLoggedIn()) return socket.emit('error:auth', 'Unauthorized Access');
    var options = {
      url: '/schema',
      json: sch,
      method: 'POST'
    };
    bkRequest(options, cb);
  });

});

server.listen(80);

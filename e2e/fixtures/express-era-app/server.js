'use strict';

var express = require('express');
var leftPad = require('left-pad');

var app = express();

app.get('/', function (req, res) {
  res.json({ name: 'express-era-app', status: 'alive' });
});

app.get('/api/pad', function (req, res) {
  res.json({ padded: leftPad('7', 3, '0'), spaced: leftPad('abc', 6) });
});

var port = process.env.PORT || 3000;
app.listen(port, function () {
  console.log('express-era-app listening on ' + port);
});

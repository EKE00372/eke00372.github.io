// Keep Chinese characters when trimming search tokens, while preserving
// Lunr's normal punctuation handling for English words.
if (i === '0') {
  var unicodeTrimmer = function (token) {
    return token.update(function (text) {
      return text.replace(/^[^\w\u3400-\u9fff\uf900-\ufaff]+/, '')
        .replace(/[^\w\u3400-\u9fff\uf900-\ufaff]+$/, '');
    });
  };
  lunr.Pipeline.registerFunction(unicodeTrimmer, 'eklib-unicode-trimmer');
  this.pipeline.before(lunr.trimmer, unicodeTrimmer);
  this.pipeline.remove(lunr.trimmer);
}

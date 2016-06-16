#! /usr/bin/env node

var path = require('path');
var fs = require('fs');
var async = require('async');
var ssh2 = require('ssh2').Client;
var util = require('util');
var prompt = require('prompt');
var colors = require("colors/safe");
var multiprompt = require('prompt');

const DEPLOYERR = "deploy should look like: { files: [<<array of file names to deploy>>], remote: 'path to remote dir', ssh: {<<object of ssh connection proerties>>} }";
var DKRBUILD = "/root/bin/dockerbuild.sh"
var DKRRUN = "/root/bin/dockerrun.sh --q"
var DKRCREATE = "/root/bin/dockercreate.sh"
var REMOTE;
var REMOTE_SRC;

var no = function() {
    if (arguments.length == 1) {
        return util.isNullOrUndefined(arguments[0]);
    } else {
        for (var i = 0; i < arguments[0].length; i++) {
            if (util.isNullOrUndefined(arguments[0][i])) {
                return arguments[1][i];
            }
        }
        return null;
    }
}

var getPath = function(resourceName) {
    return path.join(process.cwd(), resourceName);
};

var mkdir = [];
var files = [];

var walkArray = function(files, local, remote, cb) {
    async.concat(files, function(item, callback) {
        var fullPath = path.join(local, item);
        fs.lstat(fullPath, (err, stats) => {
            if (err) {
                callback(err);
            } else {
                if (stats.isDirectory()) {
                    mkdir.push(remote + "/" + item);
                    walkDir(fullPath, remote + "/" + item, callback);
                } else {
                    callback(null, { Local: fullPath, Remote: remote + "/" + item });
                }
            }
        })
    }, function(err, result) {
        if (err) {
            cb(err);
        } else {
            cb(null, result);
        }
    });
}

var walkDir = function(local, remote, cb) {
    fs.readdir(local, (err, files) => {
        walkArray(files, local, remote, cb);
    });
}

var sshCallback = function(cb) {
    return function(err, strm) {
        if (err) {
            cb(err);
        } else {
            var stdout = "";
            var stderr = "";
            strm.on('close', function(code, signal) {
                //console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
                if (code > 0) {
                    cb({ code: code, stdout: stdout, stderr: stderr });
                } else {
                    cb(null, stdout);
                }
            }).on('data', function(data) {
                stdout += data;
            }).stderr.on('data', function(data) {
                stderr += data;
            });
        }
    }
}



var cwd = function(cmd, cwd) {
    return "cd " + cwd + " && " + cmd;
}

var pkg;

try {
    pkg = require(path.join(process.cwd(), "package.json"));
} catch (err) {
    console.error("missing package.json", err);
    process.exit(1);
}

var errorHandler = function(err) {
    console.error(err);
    process.exit(1);
}

var ssh = new ssh2();

prompt.start();
multiprompt.message = "";
multiprompt.delimiter = "";
multiprompt.start();

var sshConnect = (callback) => {
    var errCb = (err) => {
        callback(err);
    }
    ssh.on('error', errCb);
    ssh.on('ready', () => {
        ssh.removeListener('error', errCb);
        callback();
    });
    ssh.connect(conn);
}

var mkdirp = function(callback) {
    var arr = mkdir.slice();
    mkdir = [];
    async.eachSeries(arr, (dirname, cb) => {
        ssh.exec('mkdir -p ' + dirname, sshCallback(
            function(err, result) {
                if (err) {
                    cb(err);
                } else {
                    console.log("created dir " + dirname);
                    cb();
                }
            }));
    }, function(err) {
        if (err) {
            console.error("failed to mkdir", err);
            callback(err);
        } else {
            callback();
        }
    });
}

var createDockerfile = (cb) => {
    var callback = (err) => {
        if (err) {
            cb(err);
        } else {
            createContainer(cb);
        }
    }
    console.log(colors.cyan("enter your Dockerfile. when done type ':w' to cancel type ':x'"));
    var dockerfile = REMOTE + "/Dockerfile"
    var getLine = function() {
        multiprompt.get({
            name: 'l',
            message: ">",
            validator: /.*/
        }, (err, res) => {
            if (err) {
                callback(err);
            } else {
                if (res.l == ":x") {
                    ssh.exec("rm -f " + dockerfile, () => {
                        callback("user aborted");
                    });
                }
                if (res.l == ":w") {
                    callback();
                } else {
                    ssh.exec("echo " + res.l + " >> " + dockerfile, ((err, res) => {
                        if (err) {
                            console.error("error during writing to remote");
                            callback(err);
                        } else {
                            getLine();
                        }
                    }))
                }
            }
        })
    }
    getLine();
}

var createContainer = (callback) => {
    console.log(colors.cyan("now enter your image name, container name, flags:"));
    prompt.get(["image name", "container name", "container flags"], (err, res) => {
        console.log();
        var dkrcreate = util.format('%s "%s" "%s" "%s"', DKRCREATE, res["image name"], res["container name"], res["container flags"]);
        ssh.exec(cwd(dkrcreate, REMOTE), sshCallback((err, result) => {
            if (err) {
                callback(err);
            } else {
                console.log("container files created");
                callback();
            }
        }))
    });
}

var checkIfDockerfileExists = (callback) => {
    ssh.exec(cwd('test -f Dockerfile', REMOTE), sshCallback((err, result) => {
        if (err) {
            prompt.get({
                name: 'create',
                message: colors.cyan('there is no Dockerfile at the target. create one [y/n]?'),
                validator: /y|n/,
                warning: 'Must respond yes (y) or no (n)',
                default: 'n'
            }, (err, res) => {
                if (!err) {
                    if (res.create == "y") {
                        createDockerfile(callback);
                    } else {
                        callback();
                    }
                } else {
                    callback(err);
                }
            });
        } else {
            callback();
        }
    }));
}

var searchAllDirs = (resources) => {
    return (callback) => {
        mkdir.push(REMOTE_SRC);
        walkArray(resources, process.cwd(), REMOTE_SRC, (err, _files) => {
            files = _files;
            callback(err);
        });
    }
}

var copyFiles = (callback) => {
    ssh.sftp((err, sftpStream) => {
        if (err) {
            console.error("error opening sftp stream", err);
            calback(err);
        } else {
            async.eachSeries(files, (copyTask, cb) => {
                sftpStream.fastPut(copyTask.Local, copyTask.Remote, (err) => {
                    if (err) {
                        cb({ error: err, task: copyTask });
                    } else {
                        console.log("copied", copyTask);
                        cb();
                    }
                });
            }, (err) => {
                if (err) {
                    console.error(colors.red("error copying files"), err);
                    callback(err);
                } else {
                    console.log("copy completed");
                    callback();
                }
            });
        }
    });
}


var build = (callback) => {
    ssh.exec(cwd(DKRBUILD, REMOTE), sshCallback(function(err, result) {
        if (err) {
            console.error("failed to run docker build", err);
            callback(err);
        } else {
            console.log("build completed");
            callback();
        }
    }))
}

var run = (callback) => {
    ssh.exec(cwd(DKRRUN, REMOTE), sshCallback(function(err, result) {
        if (err) {
            console.error("failed to dockerrun", err);
            callback(err);
        } else {
            console.log("done!");
            console.log(result);
            callback();
        }
    }));
}

if (no(pkg.deploy)) {
    console.error("missing deploy section in package.json");
    console.error(DEPLOYERR);
    process.exit(1);
} else {
    var resources = pkg.deploy.files;
    REMOTE = pkg.deploy.remote;
    if (REMOTE[REMOTE.length - 1] == '/') {
        REMOTE = REMOTE.substring(0, REMOTE.length - 1);
    }
    REMOTE_SRC = REMOTE + "/src"
    var conn = pkg.deploy.ssh;
    var missing = no([REMOTE, conn, resources], ["remote", "ssh", "files"]);
    if (missing) {
        console.error("missing " + missing + " from deploy section in package.json");
        console.error(DEPLOYERR);
    } else {
        mkdir.push(REMOTE);
        async.series([
            sshConnect,
            mkdirp,
            checkIfDockerfileExists,
            searchAllDirs(resources),
            mkdirp,
            copyFiles,
            build,
            run
        ], (err) => {
            if (err) {
                console.error(err);
            } else {
                console.log("done");
            }
            ssh.end();
            process.exit(1);
        })

        // walkArray(resources, process.cwd(), REMOTE_SRC, (err, files) => {

        //     ssh.on('ready', function() {
        //         async.eachSeries(mkdir, (dirname, cb) => {
        //             ssh.exec('mkdir -p ' + dirname, sshCallback(
        //                 function(err, result) {
        //                     if (err) {
        //                         cb(err);
        //                     } else {
        //                         cb();
        //                     }
        //                 }));
        //         }, function(err) {
        //             if (err) {
        //                 console.error("failed to mkdir", err);
        //                 ssh.end();
        //             } else {
        //                 console.log("mkdir completed")
        //                 ssh.sftp((err, sftpStream) => {
        //                     if (err) {
        //                         console.error("error opening sftp stream", err);
        //                         ssh.end();
        //                     } else {
        //                         async.eachSeries(files, (copyTask, cb) => {
        //                             sftpStream.fastPut(copyTask.Local, copyTask.Remote, (err) => {
        //                                 if (err) {
        //                                     cb({ error: err, task: copyTask });
        //                                 } else {
        //                                     console.log("copied", copyTask);
        //                                     cb();
        //                                 }
        //                             });
        //                         }, (err) => {
        //                             if (err) {
        //                                 console.error("error copying files", err);
        //                                 ssh.end();
        //                             } else {
        //                                 console.log("copy completed");
        //                                 ssh.exec(cwd('/root/bin/dockerbuild.sh', REMOTE), sshCallback(function(err, result) {
        //                                     if (err) {
        //                                         console.error("failed to run docker build", err);
        //                                         ssh.end();
        //                                     } else {
        //                                         console.log("build completed");
        //                                         ssh.exec(cwd('/root/bin/dockerrun.sh --q', REMOTE), sshCallback(function(err, result) {
        //                                             if (err) {
        //                                                 console.error("failed to dockerrun", err);
        //                                             } else {
        //                                                 console.log("done!");
        //                                                 console.log(result);
        //                                             }
        //                                             ssh.end();
        //                                         }));
        //                                     }
        //                                 }));
        //                             }
        //                         })
        //                     }

        //                 });
        //             }
        //         });
        //     });
        //     ssh.connect(conn);
        // });
    }
}

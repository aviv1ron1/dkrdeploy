#! /usr/bin/env node

var path = require('path');
var fs = require('fs');
var async = require('async');
var ssh2 = require('ssh2').Client;
var util = require('util');
var prompt = require('prompt');
var colors = require("colors/safe");
var multiprompt = require('prompt');
var args = require('args-usage-env')(require("./args.json"));

const DEPLOYERR = "run with -h to get help";
var DKRBUILD = "dockerbuild.sh";
var DKRRUN = "dockerrun.sh";
var DKRSTOP = "dockerstop.sh";
var DKRCREATE = "dockercreate.sh";
var DKRSPECT = "dockerinspect.sh";
var DKRLOG = "dockerlogs.sh";
var DOCKER_SCRIPTS = "~/bin/";
var REMOTE;
var REMOTE_SUBDIR = "src";
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

var last = function(str) {
    return str[str.length - 1];
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
        console.log("connected");
        ssh.removeListener('error', errCb);
        callback();
    });
    console.log("connecting to host " + conn.host);
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
        var dkrcreate = util.format('%s "%s" "%s" "%s"', DOCKER_SCRIPTS + DKRCREATE, res["image name"], res["container name"], res["container flags"]);
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

var checkIfDockerScriptsExist = (callback) => {
    var scripts = [DKRRUN, DKRBUILD, DKRLOG, DKRSPECT, DKRSTOP, DKRCREATE];
    scripts = scripts.map((script) => {
        return { path: DOCKER_SCRIPTS + script, name: script }
    });
    var copyScripts = [];
    async.eachSeries(scripts, (script, cb) => {
        ssh.exec(util.format('test -f %s', script.path), sshCallback((err, result) => {
            if (err) {
                prompt.get({
                    name: 'create',
                    message: colors.cyan(util.format('there is no %s script at the target. create one at %s [y/n]?', script.name, script.path)),
                    validator: /y|n/,
                    warning: 'Must respond yes (y) or no (n)',
                    default: 'y'
                }, (err, res) => {
                    if (!err) {
                        if (res.create == "y") {
                            var fullPath = path.join(__dirname, "scripts", script.name);
                            if (mkdir.indexOf(DOCKER_SCRIPTS) < 0) {
                                mkdir.push(DOCKER_SCRIPTS);
                            }
                            files.push({ Local: fullPath, Remote: script.path, chmod: "744" });
                            cb();
                        } else {
                            cb("aborted by user. must have scripts deployed on the server");
                        }
                    } else {
                        cb(err);
                    }
                });
            } else {
                cb();
            }
        }));
    }, (err) => {
        callback(err);
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
                        console.log("copied ", copyTask.Local, " to ", copyTask.Remote);
                        cb();
                    }
                });
            }, (err) => {
                if (err) {
                    console.error(colors.red("error copying files"), err);
                    callback(err);
                } else {
                    async.eachSeries(files, (copyTask, cb) => {
                        if (copyTask.chmod) {
                            ssh.exec(util.format("chmod %s %s", copyTask.chmod, copyTask.Remote), sshCallback((err, result) => {
                                cb(err);
                            }));
                        } else {
                            cb();
                        }
                    }, (err) => {
                        if (!err) {
                            console.log("copy completed");
                        }
                        callback(err);
                    })

                }
            });
        }
    });
}

var continueOrExit = (callback) => {
    if (args["copy-only"]) {
        console.log("done");
        ssh.end();
        process.exit(1);
    }
    callback();
}


var build = (callback) => {
    console.log("building...");
    ssh.exec(cwd(DOCKER_SCRIPTS + DKRBUILD, REMOTE), sshCallback(function(err, result) {
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
    console.log("running...");
    ssh.exec(cwd(DOCKER_SCRIPTS + DKRRUN + " --q", REMOTE), sshCallback(function(err, result) {
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

var inspect = (callback) => {
    setTimeout(() => {
        ssh.exec(cwd(DOCKER_SCRIPTS + DKRSPECT, REMOTE), sshCallback((err, spect) => {
            if (err) {
                console.error(err);
                callback(err);
            } else {
                console.log("-------- docker inspect --------");
                spect = JSON.parse(spect)[0];
                console.log("name", spect.Name);
                console.log("state", spect.State.Status);
                var ports = spect.NetworkSettings.Ports;
                for (var k in ports) {
                    if (ports[k]) {
                        var str = util.format("%s --> ", k);
                        ports[k].forEach((p) => {
                            str += util.format("%s, ", p.HostPort);
                        });
                        console.log(str);
                    }
                }
                console.log("--------------------------------");
                callback();
            }
        }))
    }, args.log * 1000);
}

var log = (callback) => {
    setTimeout(() => {
        ssh.exec(cwd(DOCKER_SCRIPTS + DKRLOG, REMOTE), sshCallback((err, log) => {
            if (err) {
                console.error(err);
                callback(err);
            } else {
                console.log("---------- docker log ----------");
                console.log(log);
                console.log("--------------------------------");
                callback();
            }
        }))
    }, args.log * 1000);
}

if (no(pkg.deploy)) {
    console.error("missing deploy section in package.json");
    console.error(DEPLOYERR);
    process.exit(1);
} else {
    var config = pkg.deploy;
    if (!Array.isArray(config)) {
        config = [config];
    }
    if (args.target) {
        var found = false;
        for (var i = 0; i < config.length; i++) {
            if (config[i].name == args.target) {
                config = config[i];
                found = true;
                break;
            }
        }
        if (!found) {
            console.error("target was not found");
            process.exit(1);
        }
    } else {
        config = config[0];
    }

    var resources = config.files;
    REMOTE = config.remote;
    if (last(REMOTE) == '/') {
        REMOTE = REMOTE.substring(0, REMOTE.length - 1);
    }
    if (config.docker_scripts) {
        DOCKER_SCRIPTS = config.docker_scripts;
        if (last(DOCKER_SCRIPTS) != '/') {
            DOCKER_SCRIPTS += "/";
        }
    }
    if (config.remote_subdir) {
        REMOTE_SUBDIR = config.remote_subdir;
    }
    REMOTE_SRC = REMOTE + "/" + REMOTE_SUBDIR;
    var conn = config.ssh;
    var missing = no([REMOTE, conn, resources], ["remote", "ssh", "files"]);
    if (missing) {
        console.error("missing " + missing + " from deploy section in package.json");
        console.error(DEPLOYERR);
    } else {
        mkdir.push(REMOTE);
        async.series([
            sshConnect,
            checkIfDockerScriptsExist,
            mkdirp,
            copyFiles,
            checkIfDockerfileExists,
            searchAllDirs(resources),
            mkdirp,
            copyFiles,
            continueOrExit,
            build,
            run,
            inspect,
            log
        ], (err) => {
            if (err) {
                console.error(err);
            } else {
                console.log("done");
            }
            ssh.end();
            process.exit(1);
        });
    }
}

/*
 * CDDL HEADER START
 *
 * The contents of this file are subject to the terms of the
 * Common Development and Distribution License, Version 1.0 only
 * (the "License").  You may not use this file except in compliance
 * with the License.
 *
 * You can obtain a copy of the license at http://smartos.org/CDDL
 *
 * See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * When distributing Covered Code, include this CDDL HEADER in each
 * file.
 *
 * If applicable, add the following below this CDDL HEADER, with the
 * fields enclosed by brackets "[]" replaced with your own identifying
 * information: Portions Copyright [yyyy] [name of copyright owner]
 *
 * CDDL HEADER END
 *
 * Copyright (c) 2018, Joyent, Inc.
 *
 */

var assert = require('/usr/node/node_modules/assert-plus');
var sprintf = require('/usr/node/node_modules/sprintf').sprintf;
var vasync = require('/usr/vm/node_modules/vasync');
var VM = require('/usr/vm/node_modules/VM');
var vmtest = require('../common/vmtest.js');

// this puts test stuff in global, so we need to tell jsl about that:
/* jsl:import ../node_modules/nodeunit-plus/index.js */
require('nodeunit-plus');

VM.loglevel = 'DEBUG';

/*
 * nodeuninit-plus executes the callback specified by before() before each test
 * is run and executes the callback specified by after() after each test is run.
 * These callbacks ensure that vmobj is initialized to undefined prior to each
 * test and that any VM that was created by the test is deleted after the test
 * completes.
 *
 * Tests that create a VM should be setting vmobj so that the after() hook can
 * clean up the VM when the test finishes or gives up.  If a test uses vmobj
 * then deletes the VM on its own, it should set vmobj to undefined.
 */
var vmobj;

before(function (cb) {
    vmobj = undefined;
    cb();
});

after(function (cb) {
    if (vmobj) {
        VM.delete(vmobj.uuid, {}, function _delete_cb(err) {
            if (err) {
                console.log(sprintf('Could not delete vm %s: %s', vmobj.uuid,
                    err.message));
            }
            vmobj = undefined;
            cb();
        });
    } else {
        cb();
    }
});

/*
 * This is the main driver for the happy path tests.  It does the following:
 *
 *  - creates a VM using the specified payload
 *  - optionally updates it with an update payload
 *  - verifies the disks have desired properties with correct values
 *
 * opts.t           test object
 * opts.payload     VM.create payload. Most likely should have autoboot set to
 *                  false.
 * opts.update      Optional VM.update payload
 * opts.disks       List of disks to compare to vmobj to ensure assignments are
 *                  correct. Each disk.path is used to match the disk to the
 *                  same in vmobj.disks. Set disk.mumble to undefined if wanting
 *                  to ensure that vmobj does not have mumble set on a
 *                  particular disk.
 */
function testCreateAndCheckDisks(opts) {
    var t = opts.t;
    var payload = opts.payload;
    var disks = opts.disks;
    var update = opts.update;

    vasync.waterfall([
        function _create(next) {
            VM.create(payload, function _create_cb(err, obj) {
                if (err) {
                    t.ok(false, 'error creating VM: ' + err);
                } else {
                    t.ok(true, 'VM created with uuid ' + obj.uuid);
                }
                vmobj = obj;
                next(err);
            });
        },
        function _update(next) {
            if (!update) {
                t.ok(true, 'Skipping update - nothing to do');
                next();
                return;
            }
            VM.update(vmobj.uuid, update, function _update_cb(err) {
                if (err) {
                    t.ok(false, 'error updating VM: ' + err);
                } else {
                    t.ok(true, 'VM updated');
                }
                next(err);
            });
        },
        function _load(next) {
            VM.load(vmobj.uuid, function _load_cb(err, obj) {
                if (err) {
                    t.ok(false, 'error loading VM: ' + err);
                } else {
                    t.ok(true, 'VM loaded uuid ' + obj.uuid);
                    vmobj = obj;
                }
                next(err);
            });
        },
        function _check(next) {
            next(checkDisks({
                t: t,
                haves: vmobj.disks,
                wants: disks,
                uuid: vmobj.uuid
            }));
        }
    ], function _done(err) {
        t.end(err);
    });
}

function dup(thing) {
    return JSON.parse(JSON.stringify(thing));
}

function checkDisks(opts) {
    var t = opts.t;
    var haves = opts.haves;
    var uuid = opts.uuid;
    var wants = opts.wants;
    var errors = 0;

    wants.forEach(function _check_disk(want) {
        var found = false;
        var path = sprintf(want.path, uuid);

        t.ok(true, 'Checking disk ' + path);

        haves.filter(function filter_disks(have) {
            return path == have.path;
        }).forEach(function _select_disk(have) {
            found = true;
            Object.keys(want).forEach(function _check_prop(prop) {
                if (prop === 'path') {
                    return;
                }
                var haveval = have[prop];
                var wantval = want[prop];
                t.equal(haveval, wantval,
                    'matching prop: ' + prop + '=' + haveval);
                if (haveval !== wantval) {
                    errors++;
                }
            });
        });
        t.ok(found, 'disk ' + path + ' found');
        if (!found) {
            errors++;
        }
    });
    if (errors !== 0) {
        return new Error('checkDisks encountered ' + errors + ' error(s)');
    }
    return null;
}

/*
 * VM.create() is expected to fail with an Error message that starts with
 * opts.expect.
 */
function testFailCreate(opts) {
    assert.object(opts.t, 't must be test object');
    assert.object(opts.payload, 'payload must be an object');
    assert.string(opts.expect, 'expect must be a string');
    assert.notEqual(opts.expect.length, 0, 'expect must not be empty');

    var t = opts.t;
    var payload = opts.payload;
    var expect = opts.expect;

    vasync.waterfall([
        function _create(next) {
            VM.create(payload, function _create_cb(err, obj) {
                if (err) {
                    t.equal(err.message.substring(0, expect.length), expect,
                        'error detected');
                } else {
                    t.ok(false, 'No error detected');
                }
                // This is a stub. We load() the full object below to see if it
                // was really created.
                vmobj = obj;

                next();
            });
        },
        function _load(next) {
            VM.load(vmobj.uuid, function _load_cb(err, obj) {
                vmobj = obj;
                t.ok(err, 'VM load should fail');
                if (err) {
                    next(err);
                    return;
                }
                next(new Error('VM ' + vmobj.uuid
                    + '  unexpectedly exists'));
            });
        }
        ], function _done(err) {
            t.end(err);
        });
}

/*
 * Common payload elements
 */
var image_uuid = vmtest.CURRENT_BHYVE_CENTOS_UUID;
var image_size = 10240;

var base_payload = {
    alias: 'test-bhyve-disk-resize-' + process.pid,
    brand: 'bhyve',
    do_not_inventory: true,
    autoboot: false,
    ram: 1024,
    vcpus: 1,
    disks: [
        {
            image_uuid: image_uuid,
            boot: true,
            model: 'virtio'
        }
    ]
};

/*
 * Tests, finally!
 *
 * Remember that the functions passed by before() and after() are called before
 * and after each test.
 */

test('boot disk is grown when size > image_size',
    function _verify_grow_boot_disk(t) {
        var payload = dup(base_payload);
        var newsize = image_size + 1024;
        var check_disks = [
            {
                path: '/dev/zvol/rdsk/zones/%s/disk0',
                image_uuid: image_uuid,
                boot: true,
                size: newsize
            }
        ];
        payload.disks[0].size = newsize;

        testCreateAndCheckDisks({
            t: t,
            payload: payload,
            disks: check_disks
        });
    });

test('create fails when size < image_size',
    function _conflict_no_shrink_boot_disk(t) {
        var payload = dup(base_payload);
        payload.disks[0].size = image_size - 1024;

        testFailCreate({
            t: t,
            payload: payload,
            expect: 'Invalid value(s) for: size'
        });
    });

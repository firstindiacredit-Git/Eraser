import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      index: true,
    },
    content: {
      type: String,
      default: "",
    },
    creatorSocketId: {
      type: String,
      required: true,
    },
    creatorClientId: {
      type: String,
      required: true,
    },
    creatorName: {
      type: String,
      default: "",
      trim: true,
    },
    joinedUsers: [
      {
        socketId: String,
        clientId: {
          type: String,
          required: true,
        },
        name: {
          type: String,
          default: "",
          trim: true,
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
        lastSeenAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    hasGuestJoined: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
sessionSchema.index({ code: 1 });
sessionSchema.index({ isActive: 1, lastActivity: -1 });

// Method to get total connected users
sessionSchema.methods.getTotalUsers = function () {
  return 1 + (this.joinedUsers?.length || 0); // Creator + joined users
};

sessionSchema.methods.getParticipants = function () {
  const participants = [];
  if (this.creatorSocketId && this.isActive) {
    participants.push({
      socketId: this.creatorSocketId,
      clientId: this.creatorClientId,
      name: this.creatorName || "",
      isCreator: true,
    });
  }
  if (Array.isArray(this.joinedUsers)) {
    this.joinedUsers.forEach((user) => {
      participants.push({
        socketId: user.socketId,
        clientId: user.clientId,
        name: user.name || "",
        isCreator: false,
      });
    });
  }
  return participants;
};

// Method to check if both users are connected
sessionSchema.methods.hasBothUsers = function () {
  return this.getTotalUsers() >= 2;
};

// Method to add a joined user
sessionSchema.methods.addOrUpdateUser = function (
  clientId,
  socketId,
  name = ""
) {
  if (!clientId) {
    return this;
  }

  if (this.creatorClientId === clientId) {
    this.creatorSocketId = socketId;
    this.isActive = true;
    if (name) {
      this.creatorName = name;
    }
    this.lastActivity = new Date();
    return this.save();
  }

  const existingUser = this.joinedUsers.find(
    (user) => user.clientId === clientId
  );

  if (existingUser) {
    existingUser.socketId = socketId;
    existingUser.name = name || existingUser.name;
    existingUser.lastSeenAt = new Date();
  } else {
    this.hasGuestJoined = true;
    this.joinedUsers.push({
      socketId,
      clientId,
      name,
      joinedAt: new Date(),
      lastSeenAt: new Date(),
    });
  }

  this.lastActivity = new Date();
  return this.save();
};

sessionSchema.methods.updateUserName = function (clientId, name = "") {
  if (!clientId) return this;

  if (this.creatorClientId === clientId) {
    this.creatorName = name;
  } else if (Array.isArray(this.joinedUsers)) {
    const target = this.joinedUsers.find((user) => user.clientId === clientId);
    if (target) {
      target.name = name;
    }
  }
  this.lastActivity = new Date();
  return this.save();
};

// Method to remove a user
sessionSchema.methods.removeUserByClientId = async function (clientId) {
  if (!clientId) {
    await this.save();
    return { deleted: false, session: this };
  }

  const removingCreator = this.creatorClientId === clientId;

  if (removingCreator) {
    this.isActive = false;
    this.creatorName = "";
    this.creatorSocketId = "";
  } else {
    this.joinedUsers = this.joinedUsers.filter(
      (user) => user.clientId !== clientId
    );
  }

  this.lastActivity = new Date();

  if (
    removingCreator &&
    !this.hasGuestJoined &&
    this.joinedUsers.length === 0
  ) {
    await this.deleteOne();
    return { deleted: true, session: null };
  }

  await this.save();
  return { deleted: false, session: this };
};

const Session = mongoose.model("Session", sessionSchema);

export default Session;
